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
import { AiMonthlyQuota } from './modules/reading/ai-monthly-quota.js';
import { SpeechService } from './modules/speech/speech.service.js';
import { AzureSpeechProvider } from './modules/speech/azure-speech.provider.js';
import { GoogleSpeechProvider } from './modules/speech/google-speech.provider.js';
import { policySchema } from './modules/learning/learning.policy.js';
import { PostgresRateLimiter } from './shared/middleware/rate-limit.js';
import { createApp } from './app.js';
import { env } from './shared/config/env.js';
import { CoreAuthClient } from './shared/core/core-auth.client.js';
import { createPool } from './shared/database/pool.js';
import { createLogger } from './shared/logger/logger.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GoogleAuth } from 'google-auth-library';
import { OpenverseImageProvider } from './modules/practice/openverse-image.provider.js';

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
const learningPolicy = policySchema.parse(
  env.LEARNING_POLICY_JSON ? JSON.parse(env.LEARNING_POLICY_JSON) : {},
);
const captureService = new CaptureService(
  new CaptureRepository(pool),
  profileService,
  enrichment.registry,
  enrichment.proofs,
);
const practiceService: PracticeService = new PracticeService(
  pool,
  profileService,
  learningPolicy,
  (...args): boolean => speechService.supports(...args),
  new OpenverseImageProvider(fetch),
);
const googleSpeechAccessToken =
  env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_APPLICATION_CREDENTIALS
    ? (() => {
        const auth = new GoogleAuth({
          ...(env.GOOGLE_SERVICE_ACCOUNT_JSON
            ? { credentials: JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) }
            : {}),
          scopes: ['https://www.googleapis.com/auth/cloud-platform'],
        });
        return async () => {
          const token = await auth.getAccessToken();
          if (!token) throw new Error('Google access token is unavailable');
          return token;
        };
      })()
    : undefined;
const speechProvider =
  env.SPEECH_PROVIDER === 'azure'
    ? new AzureSpeechProvider(
        env.AZURE_SPEECH_API_KEY!,
        env.AZURE_SPEECH_REGION!,
        env.AZURE_SPEECH_LANGUAGES_JSON,
      )
    : env.SPEECH_PROVIDER === 'google'
      ? new GoogleSpeechProvider(
          env.GOOGLE_SPEECH_API_KEY ?? env.GOOGLE_TRANSLATE_API_KEY!,
          env.GOOGLE_SPEECH_LANGUAGES_JSON,
          fetch,
          googleSpeechAccessToken,
        )
      : undefined;
const speechService: SpeechService = new SpeechService(pool, practiceService, speechProvider);
const rateLimiter = new PostgresRateLimiter(pool);
const readingGenerator =
  env.ANTHROPIC_API_KEY && env.AI_READING_MODEL
    ? new AnthropicReadingGenerator(
        env.ANTHROPIC_API_KEY,
        env.AI_READING_MODEL,
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
  libraryService: new LibraryRepository(pool, learningPolicy),
  practiceService,
  dashboardService: new DashboardService(pool, profileService, learningPolicy),
  transferPool: pool,
  readingService: new ReadingService(
    pool,
    profileService,
    practiceService,
    readingGenerator,
    env.ENRICHMENT_SIGNING_SECRET,
    Date.now,
    new AiMonthlyQuota(pool),
  ),
  speechService,
  enforcePaidEntitlements: env.ENFORCE_PAID_ENTITLEMENTS,
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
