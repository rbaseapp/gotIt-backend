import { ProfileRepository } from './modules/profile/profile.repository.js';
import { ProfileService } from './modules/profile/profile.service.js';
import { CaptureRepository } from './modules/capture/capture.repository.js';
import { CaptureService } from './modules/capture/capture.service.js';
import { createEnrichment } from './modules/enrichment/enrichment.config.js';
import { LibraryRepository } from './modules/library/library.repository.js';
import { PracticeService } from './modules/practice/practice.service.js';
import { DashboardService } from './modules/dashboard/dashboard.service.js';
import { ReadingService } from './modules/reading/reading.service.js';
import { AnthropicReadingGenerator } from './modules/reading/anthropic-reading.js';
import { SpeechService } from './modules/speech/speech.service.js';
import { policySchema } from './modules/learning/learning.policy.js';
import { PostgresRateLimiter } from './shared/middleware/rate-limit.js';
import { createApp } from './app.js';
import { env } from './shared/config/env.js';
import { CoreAuthClient } from './shared/core/core-auth.client.js';
import { createPool } from './shared/database/pool.js';
import { createLogger } from './shared/logger/logger.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const logger = createLogger(env.LOG_LEVEL);
const pool = createPool(env.DATABASE_URL);
pool.on('error', () => logger.error('Idle database connection failed'));
let draining = false;

try {
  const { verifyRuntimeSchema } = await import(pathToFileURL(resolve('scripts/preflight.js')).href);
  await verifyRuntimeSchema(pool, { strictRole: env.NODE_ENV === 'production' });
} catch {
  logger.fatal('Startup preflight failed; check schema migrations and runtime privileges');
  await pool.end();
  process.exit(1);
}

const coreAuthClient = new CoreAuthClient({
  baseUrl: env.CORE_API_BASE_URL,
  applicationKey: env.CORE_APPLICATION_KEY,
  timeoutMs: env.CORE_AUTH_TIMEOUT_MS,
});

const profileRepository = new ProfileRepository(pool);
const profileService = new ProfileService(profileRepository);
const enrichment = createEnrichment(env);
const captureService = new CaptureService(
  new CaptureRepository(pool),
  profileService,
  enrichment.registry,
  enrichment.proofs,
);
const practiceService: PracticeService = new PracticeService(
  pool,
  profileService,
  policySchema.parse(env.LEARNING_POLICY_JSON ? JSON.parse(env.LEARNING_POLICY_JSON) : {}),
  (...args): boolean => speechService.supports(...args),
);
const speechService: SpeechService = new SpeechService(pool, practiceService);
const rateLimiter = new PostgresRateLimiter(pool);
const readingModel = env.AI_READING_MODEL ?? env.AI_TRANSLATION_MODEL;
const readingGenerator =
  env.ANTHROPIC_API_KEY && readingModel
    ? new AnthropicReadingGenerator(
        env.ANTHROPIC_API_KEY,
        readingModel,
        env.CLAUDE_STRUCTURED_OUTPUT,
        fetch,
        env.ANTHROPIC_WORKSPACE_ID,
      )
    : undefined;

const app = createApp({
  logger,
  coreAuthClient,
  profileService,
  captureService,
  libraryService: new LibraryRepository(pool),
  practiceService,
  dashboardService: new DashboardService(pool, profileService),
  transferPool: pool,
  readingService: new ReadingService(
    pool,
    profileService,
    practiceService,
    readingGenerator,
    env.ENRICHMENT_SIGNING_SECRET,
  ),
  speechService,
  rateLimiter,
  corsOrigins: env.CORS_ORIGINS,
  trustProxyHops: env.TRUST_PROXY_HOPS,
  checkDatabase: async () => {
    if (draining) throw new Error('Draining');
    await pool.query('SELECT 1');
  },
});

const server = app.listen(env.PORT, '0.0.0.0', () => {
  logger.info(
    {
      port: env.PORT,
      environment: env.NODE_ENV,
    },
    'GotIt backend listening',
  );
});

server.requestTimeout = 90000;
server.headersTimeout = 30000;
server.keepAliveTimeout = 5000;
server.setTimeout(90000);
const cleanup = setInterval(() => {
  void rateLimiter.cleanup().catch(() => logger.warn('Request limit cleanup failed'));
}, 60000);
cleanup.unref();
server.on('error', () => {
  logger.fatal('HTTP listener failed');
  void pool.end().finally(() => process.exit(1));
});

async function shutdown(signal: string) {
  if (draining) return;
  draining = true;
  clearInterval(cleanup);
  logger.info({ signal }, 'Shutting down GotIt backend');
  const deadline = setTimeout(() => {
    server.closeAllConnections();
    logger.error('Graceful shutdown deadline exceeded');
    process.exit(1);
  }, 80000);
  deadline.unref();

  server.close(async () => {
    try {
      await pool.end();
      clearTimeout(deadline);
      process.exit(0);
    } catch {
      logger.error('Failed to close database pool');
      process.exit(1);
    }
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
