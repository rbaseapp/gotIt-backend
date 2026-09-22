import { Router } from 'express';
import { createCaptureRoutes, createLearningItemRoutes } from './modules/capture/capture.routes.js';
import { createProfileRoutes } from './modules/profile/profile.routes.js';
import { createLibraryRoutes, createTagRoutes } from './modules/library/library.routes.js';
import { createLearningRoutes, createPracticeRoutes } from './modules/practice/practice.routes.js';
import {
  createDashboardRoutes,
  createGamificationRoutes,
} from './modules/dashboard/dashboard.routes.js';
import { createTransferRoutes } from './modules/transfer/transfer.routes.js';
import { createReadingRoutes } from './modules/reading/reading.routes.js';
import {
  createPronunciationRoutes,
  createSpeechItemRoutes,
} from './modules/speech/speech.routes.js';
import { createRateLimit } from './shared/middleware/rate-limit.js';
import { API_ROUTES } from './shared/http/api-catalog.js';
import { AppError } from './shared/errors/app-error.js';
import type { AppDependencies } from './shared/http/dependencies.js';
import { createAuthenticateMiddleware } from './shared/middleware/authenticate.js';
import { createRequireEntitlementMiddleware } from './shared/middleware/require-entitlement.js';

export function createRoutes(dependencies: AppDependencies) {
  const router = Router();
  const authenticate = dependencies.rateLimiter
    ? [
        createAuthenticateMiddleware(dependencies.coreAuthClient),
        createRateLimit(dependencies.rateLimiter, 'user', 120),
      ]
    : [createAuthenticateMiddleware(dependencies.coreAuthClient)];

  router.get('/health', (request, response) => {
    response.status(200).json({
      status: 'ok',
      service: 'gotit-backend',
      requestId: request.id,
    });
  });

  router.get('/ready', async (request, response, next) => {
    try {
      await dependencies.checkDatabase();

      response.status(200).json({
        status: 'ready',
        service: 'gotit-backend',
        dependencies: {
          database: 'ok',
        },
        requestId: request.id,
      });
    } catch (error) {
      next(
        new AppError(
          503,
          'NOT_READY',
          'Service is not ready',
          error instanceof Error ? { dependency: 'database' } : undefined,
        ),
      );
    }
  });

  router.get('/api/v1', (request, response) => {
    response.status(200).json({
      name: 'GotIt Backend API',
      routes: API_ROUTES,
      version: 'v1',
      service: 'gotit-backend',
      requestId: request.id,
    });
  });

  router.use('/api/v1', ...authenticate);
  router.get('/api/v1/capabilities', async (req, res) => {
    const profile = await dependencies.profileService.getProfile(req.gotitAuth!);
    res.json({
      configured: {
        library: Boolean(dependencies.libraryService),
        practice: Boolean(dependencies.practiceService),
        dashboard: Boolean(dependencies.dashboardService),
        readingGeneration: dependencies.readingService?.available ?? false,
        speech: dependencies.speechService?.available ?? false,
      },
      learningLanguages: profile.languages.map((l) => ({
        languageCode: l.languageCode,
        enabledSkills: dependencies.practiceService?.availableSkills(profile, l.languageCode) ?? [],
      })),
      requestId: req.id,
    });
  });
  router.use('/api/v1/profile', createProfileRoutes(dependencies.profileService));
  if (dependencies.libraryService) {
    router.use('/api/v1/learning-items', createLibraryRoutes(dependencies.libraryService));
    router.use('/api/v1/tags', createTagRoutes(dependencies.libraryService));
  }
  if (dependencies.practiceService) {
    router.use('/api/v1/practice', createPracticeRoutes(dependencies.practiceService));
    router.use('/api/v1/learning', createLearningRoutes(dependencies.practiceService));
  }
  if (dependencies.dashboardService) {
    router.use('/api/v1/dashboard', createDashboardRoutes(dependencies.dashboardService));
    router.use('/api/v1/gamification', createGamificationRoutes(dependencies.dashboardService));
  }
  if (dependencies.readingService)
    router.use(
      '/api/v1/reading',
      createReadingRoutes(
        dependencies.readingService,
        createRequireEntitlementMiddleware(
          dependencies.coreAuthClient,
          'reading.ai',
          dependencies.enforcePaidEntitlements === true,
        ),
      ),
    );
  if (dependencies.speechService) {
    router.use(
      '/api/v1/learning-items',
      createSpeechItemRoutes(
        dependencies.speechService,
        createRequireEntitlementMiddleware(
          dependencies.coreAuthClient,
          'speech.audio',
          dependencies.enforcePaidEntitlements === true,
        ),
      ),
    );
    router.use(
      '/api/v1/pronunciation',
      createPronunciationRoutes(
        dependencies.speechService,
        createRequireEntitlementMiddleware(
          dependencies.coreAuthClient,
          'speech.pronunciation',
          dependencies.enforcePaidEntitlements === true,
        ),
      ),
    );
  }
  if (dependencies.transferPool && dependencies.captureService)
    router.use(
      '/api/v1',
      createTransferRoutes(dependencies.transferPool, dependencies.captureService),
    );
  if (dependencies.captureService) {
    router.use('/api/v1/captures', createCaptureRoutes(dependencies.captureService));
    router.use('/api/v1/learning-items', createLearningItemRoutes(dependencies.captureService));
  }

  return router;
}
