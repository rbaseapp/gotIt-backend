import { Router, type RequestHandler } from 'express';
import type { CaptureService } from './capture.service.js';
import { createCaptureController } from './capture.controller.js';

export function createCaptureRoutes(
  service: CaptureService,
  requireWrite: RequestHandler,
  requirePaidAiTranslation?: RequestHandler,
) {
  const router = Router();
  const controller = createCaptureController(service);
  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  router.post(
    '/preview',
    (request, response, next) => {
      // Explicit dictionary previews use only non-AI providers and do not save a
      // learning item. Keep auto/profile routing gated: it can select paid AI.
      if (request.body?.translationMethod === 'dictionary') return next();
      return requireWrite(request, response, next);
    },
    (request, response, next) => {
      if (request.body?.translationMethod === 'ai' && requirePaidAiTranslation)
        return requirePaidAiTranslation(request, response, next);
      next();
    },
    controller.preview,
  );
  router.post('/', requireWrite, controller.save);
  return router;
}
export function createLearningItemRoutes(service: CaptureService) {
  const router = Router();
  const controller = createCaptureController(service);
  router.use((_request, response, next) => {
    response.set('Cache-Control', 'no-store');
    next();
  });
  router.get('/:id', controller.detail);
  return router;
}
