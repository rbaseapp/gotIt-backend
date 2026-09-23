import { Router, type RequestHandler } from 'express';
import { parseInput, uuidSchema } from '../capture/capture.validation.js';
import { pageSchema } from '../library/library.validation.js';
import {
  attemptSchema,
  closeSessionSchema,
  exercisesSchema,
  sessionSchema,
} from './practice.validation.js';
import type { PracticeService } from './practice.service.js';

export function createPracticeRoutes(service: PracticeService, requirePlay: RequestHandler) {
  const router = Router();
  router.get('/sessions', async (req, res) => {
    const page = parseInput(pageSchema, req.query);
    res.json({
      ...(await service.sessions(req.gotitAuth!, page.limit, page.cursor)),
      requestId: req.id,
    });
  });
  router.post('/sessions', requirePlay, async (req, res) => {
    const result = await service.createSession(
      req.gotitAuth!,
      parseInput(uuidSchema, req.get('Idempotency-Key')),
      parseInput(sessionSchema, req.body),
    );
    res.status(result.replayed ? 200 : 201).json({ ...result, requestId: req.id });
  });
  router.get('/sessions/:id', async (req, res) =>
    res.json({
      session: await service.getSession(req.gotitAuth!, parseInput(uuidSchema, req.params.id)),
      requestId: req.id,
    }),
  );
  router.get('/sessions/:id/study', requirePlay, async (req, res) =>
    res.json({
      ...(await service.studyCards(req.gotitAuth!, parseInput(uuidSchema, req.params.id))),
      requestId: req.id,
    }),
  );
  router.get('/sessions/:id/study/:itemId/image', requirePlay, async (req, res) =>
    res.set('Cache-Control', 'private, max-age=86400').json({
      ...(await service.studyImage(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        parseInput(uuidSchema, req.params.itemId),
      )),
      requestId: req.id,
    }),
  );
  router.patch('/sessions/:id', requirePlay, async (req, res) =>
    res.json({
      session: await service.closeSession(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        parseInput(closeSessionSchema, req.body).status,
      ),
      requestId: req.id,
    }),
  );
  router.post('/sessions/:id/exercises', requirePlay, async (req, res) =>
    res.status(201).json({
      ...(await service.issueExercises(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        parseInput(exercisesSchema, req.body),
      )),
      requestId: req.id,
    }),
  );
  router.post('/attempts', requirePlay, async (req, res) => {
    const result = await service.submitAttempt(
      req.gotitAuth!,
      parseInput(uuidSchema, req.get('Idempotency-Key')),
      parseInput(attemptSchema, req.body),
    );
    res.status(result.replayed ? 200 : 201).json({ ...result, requestId: req.id });
  });
  return router;
}

export function createLearningRoutes(service: PracticeService) {
  const router = Router();
  router.get('/config', (_req, res) =>
    res.json({ policy: service.policy, algorithmVersion: service.version, requestId: _req.id }),
  );
  router.get('/queue', async (req, res) => {
    const page = parseInput(pageSchema.omit({ cursor: true }), req.query);
    res.json({ ...(await service.queue(req.gotitAuth!, page.limit)), requestId: req.id });
  });
  return router;
}
