import { Router, type RequestHandler } from 'express';
import { parseInput } from '../capture/capture.validation.js';
import type { PrivateLessonService } from './private-lesson.service.js';
import { privateLessonInputSchema } from './private-lesson.validation.js';

export function createPrivateLessonRoutes(
  service: PrivateLessonService,
  requireLessonAccess: RequestHandler,
) {
  const router = Router();

  router.post('/realtime-sessions', requireLessonAccess, async (request, response) => {
    response.status(201).json({
      ...(await service.createSession(
        request.gotitAuth!,
        parseInput(privateLessonInputSchema, request.body),
      )),
      requestId: request.id,
    });
  });

  return router;
}
