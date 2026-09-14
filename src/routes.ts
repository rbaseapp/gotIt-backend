import { Router } from 'express';
import { createProfileRoutes } from './modules/profile/profile.routes.js';
import { AppError } from './shared/errors/app-error.js';
import type { AppDependencies } from './shared/http/dependencies.js';
import { createAuthenticateMiddleware } from './shared/middleware/authenticate.js';

export function createRoutes(dependencies: AppDependencies) {
  const router = Router();
  const authenticate = createAuthenticateMiddleware(dependencies.coreAuthClient);

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
      version: 'v1',
      service: 'gotit-backend',
      requestId: request.id,
    });
  });

  router.use('/api/v1/profile', authenticate, createProfileRoutes(dependencies.profileService));

  return router;
}
