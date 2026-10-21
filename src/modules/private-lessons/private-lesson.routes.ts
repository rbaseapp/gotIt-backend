import { unitPathChoiceSchema } from '../word-packs/unit-path-choices.js';
import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { lessonActivityCommandSchema as legacyCommandSchema } from './private-lesson.legacy-activity.js';
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
  privateLessonVoiceSampleSchema,
} from './private-lesson.validation.js';

export function createPrivateLessonRoutes(
  service: PrivateLessonService,
  requireLessonAccess: RequestHandler,
) {
  const router = Router();
  router.post('/units/:id/path-choices', async (req, res) =>
    res.json({
      path: await service.chooseUnitPath(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        parseInput(unitPathChoiceSchema, req.body),
      ),
      requestId: req.id,
    }),
  );
  router.post('/voice-sample', requireLessonAccess, async (request, response) => {
    const input = parseInput(privateLessonVoiceSampleSchema, request.body);
    response.setHeader('Cache-Control', 'private, no-store');
    response.json({
      ...(await service.voiceSample(request.gotitAuth!, input.teacherVoice)),
      requestId: request.id,
    });
  });

  // Read-only progression is available without purchasing or starting a teacher call.
  router.get('/units/:id/map', async (request, response) =>
    response.json({
      requestId: request.id,
      path: await service.getLearningMap(
        request.gotitAuth!,
        parseInput(uuidSchema, request.params.id),
      ),
    }),
  );

  router.get('/units/:id', requireLessonAccess, async (request, response) => {
    response.json({
      unit: await service.getPreparedUnit(
        request.gotitAuth!,
        parseInput(uuidSchema, request.params.id),
      ),
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
    if (request.body?.interactionProtocol === 'adaptive-v1') response.setTimeout(210_000);
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

  router.get('/:id/activity', requireLessonAccess, async (request, response) => {
    response.json({
      ...(await service.getActivity(request.gotitAuth!, parseInput(uuidSchema, request.params.id))),
      requestId: request.id,
    });
  });
  router.post('/:id/activity', requireLessonAccess, async (request, response) => {
    response.json({
      ...(await service.act(
        request.gotitAuth!,
        parseInput(uuidSchema, request.params.id),
        parseInput(z.union([lessonActivityCommandSchema, legacyCommandSchema]), request.body),
      )),
      requestId: request.id,
    });
  });
  router.post('/:id/replay', requireLessonAccess, async (request, response) => {
    const input = parseInput(
      z
        .object({ kind: z.enum(['original', 'translation']), rate: z.enum(['normal', 'slow']) })
        .strict(),
      request.body,
    );
    response.json({
      ...(await service.replayTurn(
        request.gotitAuth!,
        parseInput(uuidSchema, request.params.id),
        input,
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
