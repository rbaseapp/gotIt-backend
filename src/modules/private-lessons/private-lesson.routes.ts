import { Router, type RequestHandler } from 'express';
import { parseInput } from '../capture/capture.validation.js';
import { uuidSchema } from '../capture/capture.validation.js';
import type { PrivateLessonService } from './private-lesson.service.js';
import { lessonActivityCommandSchema } from './private-lesson.activity.js';
import {
  privateLessonCompletionSchema,
  privateLessonInputSchema,
  privateLessonListSchema,
  privateLessonPreferencesInputSchema,
  privateLessonRoadmapInputSchema,
  privateLessonSetupSchema,
  lessonReplaySchema,
  privateLessonVoiceSampleSchema,
} from './private-lesson.validation.js';

export function createPrivateLessonRoutes(
  service: PrivateLessonService,
  requireLessonAccess: RequestHandler,
) {
  const router = Router();
  router.post('/voice-sample', requireLessonAccess, async (request, response) => {
    const input = parseInput(privateLessonVoiceSampleSchema, request.body);
    response.setHeader('Cache-Control', 'private, no-store');
    response.json({
      ...(await service.voiceSample(request.gotitAuth!, input.teacherVoice)),
      requestId: request.id,
    });
  });
  router.get('/units/:packId', requireLessonAccess, async (request, response) => {
    response.json({
      ...(await service.getUnit(request.gotitAuth!, parseInput(uuidSchema, request.params.packId))),
      requestId: request.id,
    });
  });

  router.get('/setup', requireLessonAccess, async (request, response) => {
    const input = parseInput(privateLessonSetupSchema, request.query);
    response.json({
      ...(await service.getSetup(request.gotitAuth!, input.targetLanguageCode)),
      requestId: request.id,
    });
  });

  router.post('/roadmaps', requireLessonAccess, async (request, response) => {
    response.status(201).json({
      ...(await service.createRoadmap(
        request.gotitAuth!,
        parseInput(privateLessonRoadmapInputSchema, request.body),
      )),
      requestId: request.id,
    });
  });

  router.put('/preferences', requireLessonAccess, async (request, response) => {
    response.json({
      ...(await service.savePreferences(
        request.gotitAuth!,
        parseInput(privateLessonPreferencesInputSchema, request.body),
      )),
      requestId: request.id,
    });
  });

  router.post('/realtime-sessions', requireLessonAccess, async (request, response) => {
    response.status(201).json({
      ...(await service.createSession(
        request.gotitAuth!,
        parseInput(privateLessonInputSchema, request.body),
        request.gotitCoreAccessToken,
      )),
      requestId: request.id,
    });
  });

  router.get('/', requireLessonAccess, async (request, response) => {
    const input = parseInput(privateLessonListSchema, request.query);
    response.json({
      ...(await service.listSessions(
        request.gotitAuth!,
        input.limit,
        input.courseId,
        input.packId,
        input.targetLanguageCode,
      )),
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

  router.get('/:id/activity', requireLessonAccess, async (request, response) => {
    response.json({
      ...(await service.getActivity(request.gotitAuth!, parseInput(uuidSchema, request.params.id))),
      requestId: request.id,
    });
  });
  router.post('/:id/replay', requireLessonAccess, async (request, response) => {
    response.json({
      ...(await service.replayTurn(
        request.gotitAuth!,
        parseInput(uuidSchema, request.params.id),
        parseInput(lessonReplaySchema, request.body),
      )),
      requestId: request.id,
    });
  });

  router.post('/:id/activity', requireLessonAccess, async (request, response) => {
    response.json({
      ...(await service.act(
        request.gotitAuth!,
        parseInput(uuidSchema, request.params.id),
        parseInput(lessonActivityCommandSchema, request.body),
      )),
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
