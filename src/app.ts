import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { createRoutes } from './routes.js';
import type { AppDependencies } from './shared/http/dependencies.js';
import { errorHandler } from './shared/middleware/error-handler.js';
import { notFoundHandler } from './shared/middleware/not-found.js';
import { requestIdMiddleware } from './shared/middleware/request-id.js';
import { createCors } from './shared/middleware/cors.js';
import { createRateLimit } from './shared/middleware/rate-limit.js';

export function createApp(dependencies: AppDependencies) {
  const app = express();

  app.disable('x-powered-by');
  if (dependencies.trustProxyHops) app.set('trust proxy', dependencies.trustProxyHops);
  app.use(helmet());
  app.use(requestIdMiddleware);

  app.use(
    pinoHttp({
      logger: dependencies.logger,
      serializers: { req: (request) => ({ ...request, url: request.url?.split('?')[0] }) },
      genReqId: (request) => request.id,
      customProps: (request) => ({
        requestId: String(request.id),
      }),
    }),
  );

  app.use(createCors(dependencies.corsOrigins));
  app.use('/api/v1', (_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  if (dependencies.rateLimiter)
    app.use('/api/v1', createRateLimit(dependencies.rateLimiter, 'ip', 240));
  app.use('/api/v1/pronunciation/assessments', express.json({ limit: '1mb' }));
  app.use(express.json({ limit: '256kb' }));
  app.use(createRoutes(dependencies));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
