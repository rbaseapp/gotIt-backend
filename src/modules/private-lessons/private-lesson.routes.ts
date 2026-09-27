import { Router, type RequestHandler } from 'express';
import { parseInput } from '../capture/capture.validation.js';
import { uuidSchema } from '../capture/capture.validation.js';
import type { PrivateLessonService } from './private-lesson.service.js';
import {
  privateLessonCompletionSchema,
  privateLessonInputSchema,
  privateLessonListSchema,
} from './private-lesson.validation.js';

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

  router.get('/', requireLessonAccess, async (request, response) => {
    const input = parseInput(privateLessonListSchema, request.query);
    response.json({
      ...(await service.listSessions(request.gotitAuth!, input.limit)),
      requestId: request.id,
    });
  });

  router.post('/:id/complete', requireLessonAccess, async (request, response) => {
    response.json({
      lesson: await service.completeSession(
        request.gotitAuth!,
        parseInput(uuidSchema, request.params.id),
        parseInput(privateLessonCompletionSchema, request.body),
      ),
      requestId: request.id,
    });
  });

  router.get('/:id', requireLessonAccess, async (request, response) => {
    response.json({
      lesson: await service.getSession(
        request.gotitAuth!,
        parseInput(uuidSchema, request.params.id),
      ),
      requestId: request.id,
    });
  });

  router.delete('/:id', requireLessonAccess, async (request, response) => {
    response.json({
      ...(await service.removeSession(
        request.gotitAuth!,
        parseInput(uuidSchema, request.params.id),
      )),
      requestId: request.id,
    });
  });

  return router;
}
