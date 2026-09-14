import { ProfileRepository } from './modules/profile/profile.repository.js';
import { ProfileService } from './modules/profile/profile.service.js';
import { createApp } from './app.js';
import { env } from './shared/config/env.js';
import { CoreAuthClient } from './shared/core/core-auth.client.js';
import { createPool } from './shared/database/pool.js';
import { createLogger } from './shared/logger/logger.js';

const logger = createLogger(env.LOG_LEVEL);
const pool = createPool(env.DATABASE_URL);

const coreAuthClient = new CoreAuthClient({
  baseUrl: env.CORE_API_BASE_URL,
  applicationKey: env.CORE_APPLICATION_KEY,
  timeoutMs: env.CORE_AUTH_TIMEOUT_MS,
});

const profileRepository = new ProfileRepository(pool);
const profileService = new ProfileService(profileRepository);

const app = createApp({
  logger,
  coreAuthClient,
  profileService,
  checkDatabase: async () => {
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

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down GotIt backend');

  server.close(async () => {
    try {
      await pool.end();
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'Failed to close database pool');
      process.exit(1);
    }
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
