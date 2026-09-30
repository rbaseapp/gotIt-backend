import { ProfileRepository } from './modules/profile/profile.repository.js';
import { ProfileService } from './modules/profile/profile.service.js';
import { NotificationRepository } from './modules/notifications/notification.repository.js';
import { NotificationService } from './modules/notifications/notification.service.js';
import { createNotificationSender } from './modules/notifications/notification.providers.js';
import { CaptureRepository } from './modules/capture/capture.repository.js';
import { CaptureService } from './modules/capture/capture.service.js';
import { createEnrichment } from './modules/enrichment/enrichment.config.js';
import { LibraryRepository } from './modules/library/library.repository.js';
import { PracticeService } from './modules/practice/practice.service.js';
import { DashboardService } from './modules/dashboard/dashboard.service.js';
import { ReadingService } from './modules/reading/reading.service.js';
import { OpenAiReadingGenerator } from './modules/reading/openai-reading.js';
import { AiMonthlyQuota } from './modules/reading/ai-monthly-quota.js';
import { SpeechService } from './modules/speech/speech.service.js';
import { AzureSpeechProvider } from './modules/speech/azure-speech.provider.js';
import { GoogleSpeechProvider } from './modules/speech/google-speech.provider.js';
import { policySchema } from './modules/learning/learning.policy.js';
import { PostgresRateLimiter } from './shared/middleware/rate-limit.js';
import { AiDailyQuota } from './shared/middleware/ai-daily-quota.js';
import { createApp } from './app.js';
import { env } from './shared/config/env.js';
import { CoreAuthClient } from './shared/core/core-auth.client.js';
import { createPool } from './shared/database/pool.js';
import { createLogger } from './shared/logger/logger.js';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GoogleAuth } from 'google-auth-library';
import { OpenAiStudyImageProvider } from './modules/practice/openai-study-image.provider.js';
import { OpenAiStudyImageBriefResolver } from './modules/practice/openai-study-image-brief.resolver.js';
import { PixabayStudyImageProvider } from './modules/practice/pixabay-study-image.provider.js';
import { FallbackStudyImageProvider } from './modules/practice/study-image.provider.js';
import { WordPackRepository } from './modules/word-packs/word-packs.repository.js';
import { PrivateLessonService } from './modules/private-lessons/private-lesson.service.js';
import { CourseService } from './modules/courses/course.service.js';
import { PostgresLearningDocumentStore } from './modules/courses/course.repository.js';
import { OpenAiCourseGenerator } from './modules/courses/course.provider.js';
import { PostgresPrivateLessonRoadmapStore } from './modules/private-lessons/private-lesson.roadmap.js';
import {
  PostgresPrivateLessonJournal,
  PostgresPrivateLessonVocabularySource,
} from './modules/private-lessons/private-lesson.repository.js';
import { OpenAiPrivateLessonSummaryGenerator } from './modules/private-lessons/private-lesson.summary.js';
import { PostgresPrivateLessonProficiencyStore } from './modules/private-lessons/private-lesson.proficiency.js';
import { PostgresAddonAccess } from './modules/addons/addon-access.js';
import { PostgresMinuteWallet } from './modules/private-lessons/minute-wallet.js';
import { PostgresRealtimeCallGuard } from './modules/private-lessons/realtime-call-guard.js';

const logger = createLogger(env.LOG_LEVEL);
const pool = createPool(env.DATABASE_URL);
const addonAccess = new PostgresAddonAccess(pool);
pool.on('error', () => logger.error('Idle database connection failed'));
let draining = false;

try {
  const { verifyRuntimeSchema } = await import(pathToFileURL(resolve('scripts/preflight.js')).href);
  await verifyStartupSchema(() =>
    verifyRuntimeSchema(pool, { strictRole: env.NODE_ENV === 'production' }),
  );
} catch (error) {
  logger.fatal(
    { preflightCode: safePreflightFailureCode(error) },
    'Startup preflight failed; check schema migrations, runtime privileges, and DATABASE_URL',
  );
  await pool.end();
  process.exit(1);
}

async function verifyStartupSchema(verify: () => Promise<unknown>) {
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await verify();
    } catch (error) {
      if (attempt === attempts || !isTransientPreflightFailure(error)) throw error;
      logger.warn(
        { attempt, attempts, preflightCode: safePreflightFailureCode(error) },
        'Startup preflight database connection is temporarily unavailable; retrying',
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 750));
    }
  }
}

function safePreflightFailureCode(error: unknown) {
  if (error instanceof Error && /^GOTIT_[A-Z_]+$|^DATABASE_URL_REQUIRED$/u.test(error.message))
    return error.message;
  const databaseCode =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  if (databaseCode === '28P01') return 'PREFLIGHT_DATABASE_AUTHENTICATION_FAILED';
  if (databaseCode === '3D000') return 'PREFLIGHT_DATABASE_NOT_FOUND';
  return 'PREFLIGHT_DATABASE_UNAVAILABLE';
}

function isTransientPreflightFailure(error: unknown) {
  const databaseCode =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  if (
    databaseCode.startsWith('08') ||
    ['57P03', '57014', '53300', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'].includes(
      databaseCode,
    )
  )
    return true;
  return (
    error instanceof Error &&
    /connection.*(?:timeout|terminated)|timeout.*connection/iu.test(error.message)
  );
}

const coreAuthClient = new CoreAuthClient({
  baseUrl: env.CORE_API_BASE_URL,
  applicationKey: env.CORE_APPLICATION_KEY,
  timeoutMs: env.CORE_AUTH_TIMEOUT_MS,
});
const minuteWallet = new PostgresMinuteWallet(pool, coreAuthClient);
const rateLimiter = new PostgresRateLimiter(pool);
const aiDailyQuota = new AiDailyQuota(rateLimiter);
const realtimeApiKey = env.OPENAI_REALTIME_API_KEY ?? env.OPENAI_API_KEY;
const realtimeCallGuard = realtimeApiKey
  ? new PostgresRealtimeCallGuard(pool, realtimeApiKey, minuteWallet)
  : undefined;

const profileRepository = new ProfileRepository(pool);
const profileService = new ProfileService(profileRepository);
const notificationRepository = new NotificationRepository(pool);
const notificationService = new NotificationService(
  notificationRepository,
  profileService,
  createNotificationSender(
    {
      smtpHost: env.NOTIFICATION_SMTP_HOST,
      smtpPort: env.NOTIFICATION_SMTP_PORT,
      smtpUser: env.NOTIFICATION_SMTP_USER,
      smtpPassword: env.NOTIFICATION_SMTP_PASSWORD,
      emailFrom: env.NOTIFICATION_EMAIL_FROM,
      vapidSubject: env.NOTIFICATION_VAPID_SUBJECT,
      vapidPublicKey: env.NOTIFICATION_VAPID_PUBLIC_KEY,
      vapidPrivateKey: env.NOTIFICATION_VAPID_PRIVATE_KEY,
    },
    notificationRepository,
  ),
  env.NOTIFICATION_VAPID_PUBLIC_KEY,
);
const enrichment = createEnrichment(env, [], aiDailyQuota);
const learningPolicy = policySchema.parse(
  env.LEARNING_POLICY_JSON ? JSON.parse(env.LEARNING_POLICY_JSON) : {},
);
const captureService = new CaptureService(
  new CaptureRepository(pool),
  profileService,
  enrichment.registry,
  enrichment.proofs,
);
const studyImageProviders = [
  ...(env.PIXABAY_API_KEY ? [new PixabayStudyImageProvider(env.PIXABAY_API_KEY, fetch)] : []),
  ...(env.OPENAI_API_KEY
    ? [
        new OpenAiStudyImageProvider(
          env.OPENAI_API_KEY,
          env.OPENAI_IMAGE_MODEL ?? 'gpt-image-2.5-flare',
          fetch,
          aiDailyQuota,
        ),
      ]
    : []),
];
const studyImageBriefResolver =
  env.OPENAI_API_KEY && env.OPENAI_TRANSLATION_MODEL
    ? new OpenAiStudyImageBriefResolver(
        env.OPENAI_API_KEY,
        env.OPENAI_TRANSLATION_MODEL,
        fetch,
        aiDailyQuota,
      )
    : undefined;
const practiceService: PracticeService = new PracticeService(
  pool,
  profileService,
  learningPolicy,
  (...args): boolean => speechService.supports(...args),
  studyImageProviders.length
    ? new FallbackStudyImageProvider(studyImageProviders, studyImageBriefResolver)
    : undefined,
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
const privateLessonContentApiKey = env.OPENAI_API_KEY ?? env.OPENAI_REALTIME_API_KEY;
const privateLessonContentGenerator = privateLessonContentApiKey
  ? new OpenAiCourseGenerator(
      privateLessonContentApiKey,
      env.OPENAI_PRIVATE_LESSON_MODEL,
      env.OPENAI_REALTIME_TRANSCRIPTION_MODEL,
      fetch,
      aiDailyQuota,
    )
  : undefined;
const courseService = new CourseService(
  new PostgresLearningDocumentStore(pool),
  profileService,
  privateLessonContentGenerator,
  (env.OPENAI_REALTIME_API_KEY ?? env.OPENAI_API_KEY)
    ? {
        apiKey: (env.OPENAI_REALTIME_API_KEY ?? env.OPENAI_API_KEY)!,
        model: env.OPENAI_REALTIME_MODEL,
        transcriptionModel: env.OPENAI_REALTIME_TRANSCRIPTION_MODEL,
        callGuard: realtimeCallGuard,
      }
    : undefined,
);
const privateLessonService = new PrivateLessonService({
  courses: courseService,
  lessonContentGenerator: privateLessonContentGenerator,
  apiKey: env.OPENAI_REALTIME_API_KEY ?? env.OPENAI_API_KEY,
  model: env.OPENAI_REALTIME_MODEL,
  voice: env.OPENAI_REALTIME_VOICE,
  transcriptionModel: env.OPENAI_REALTIME_TRANSCRIPTION_MODEL,
  profiles: profileService,
  vocabulary: new PostgresPrivateLessonVocabularySource(pool),
  fetchImpl: fetch,
  journal: new PostgresPrivateLessonJournal(pool),
  roadmaps: new PostgresPrivateLessonRoadmapStore(pool),
  proficiency: new PostgresPrivateLessonProficiencyStore(pool),
  summaryGenerator: privateLessonContentApiKey
    ? new OpenAiPrivateLessonSummaryGenerator(
        privateLessonContentApiKey,
        env.OPENAI_PRIVATE_LESSON_MODEL,
        fetch,
      )
    : undefined,
  lessonAccess: env.ENFORCE_ADDON_ENTITLEMENTS ? addonAccess : undefined,
  minuteWallet,
  realtimeCallGuard,
  dailyQuota: aiDailyQuota,
});
const readingGenerator =
  env.OPENAI_API_KEY && env.AI_READING_MODEL
    ? new OpenAiReadingGenerator(env.OPENAI_API_KEY, env.AI_READING_MODEL, fetch)
    : undefined;

const app = createApp({
  logger,
  coreAuthClient,
  profileService,
  notificationService,
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
  privateLessonService,
  courseService,
  addonAccess,
  minuteWallet,
  realtimeCallGuard,
  enforceAddonEntitlements: env.ENFORCE_ADDON_ENTITLEMENTS,
  wordPackService: new WordPackRepository(pool),
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
let realtimeSweepActive = false;
const sweepRealtime = async () => {
  if (draining || realtimeSweepActive || !realtimeCallGuard) return;
  realtimeSweepActive = true;
  try {
    await realtimeCallGuard.sweep();
  } catch {
    logger.error('Realtime call cleanup failed');
  } finally {
    realtimeSweepActive = false;
  }
};
const realtimeTimer = setInterval(() => void sweepRealtime(), 10_000);
realtimeTimer.unref();
void sweepRealtime();
let notificationRunActive = false;
const runNotifications = async () => {
  if (draining || notificationRunActive) return;
  notificationRunActive = true;
  try {
    const result = await notificationService.run();
    if (result.queued || result.processed) logger.info(result, 'Notification cycle completed');
  } catch {
    logger.error('Notification cycle failed');
  } finally {
    notificationRunActive = false;
  }
};
const notificationTimer = setInterval(() => void runNotifications(), 60000);
notificationTimer.unref();
void runNotifications();
server.on('error', () => {
  logger.fatal('HTTP listener failed');
  void pool.end().finally(() => process.exit(1));
});

async function shutdown(signal: string) {
  if (draining) return;
  draining = true;
  clearInterval(cleanup);
  clearInterval(realtimeTimer);
  clearInterval(notificationTimer);
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
