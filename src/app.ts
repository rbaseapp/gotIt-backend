import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { createRoutes } from './routes.js';
import type { AppDependencies } from './shared/http/dependencies.js';
import { errorHandler } from './shared/middleware/error-handler.js';
import { notFoundHandler } from './shared/middleware/not-found.js';
import { requestIdMiddleware } from './shared/middleware/request-id.js';

export function createApp(dependencies: AppDependencies) {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '256kb' }));
  app.use(requestIdMiddleware);

  app.use(
    pinoHttp({
      logger: dependencies.logger,
      genReqId: (request) => request.id,
      customProps: (request) => ({
        requestId: String(request.id),
      }),
    }),
  );

  app.use(createRoutes(dependencies));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
