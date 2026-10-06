import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { parseInput, uuidSchema } from '../capture/capture.validation.js';
import {
  commandSchema,
  coursePreferencesSchema,
  courseTurnSchema,
  homeworkActionSchema,
  intakeStartSchema,
  speechInputSchema,
} from './course.schemas.js';
import { CourseService, publicCourse, publicHomework } from './course.service.js';

export function createCourseRoutes(service: CourseService, requireAccess: RequestHandler) {
  const router = Router();
  router.use(requireAccess);
  router.get('/', async (req, res) => res.json(await service.list(req.gotitAuth!)));
  router.post('/intake', async (req, res) =>
    res.status(201).json({
      course: await service.start(req.gotitAuth!, parseInput(intakeStartSchema, req.body)),
    }),
  );
  router.post('/transcribe', async (req, res) => {
    const input = parseInput(speechInputSchema, req.body);
    res.json(await service.transcribe(req.gotitAuth!, input.audioBase64, input.languageCode));
  });
  router.get('/homework/:id', async (req, res) =>
    res.json({
      homework: publicHomework(
        await service.homework(req.gotitAuth!, parseInput(uuidSchema, req.params.id)),
      ),
    }),
  );
  router.post('/homework/:id/prepare', async (req, res) => {
    // Homework can require generation and independent review before the first byte is sent.
    req.setTimeout(225_000);
    res.json({
      homework: await service.prepareHomework(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        parseInput(commandSchema, req.body),
      ),
    });
  });
  router.post('/homework/:id/actions', async (req, res) =>
    res.json({
      homework: await service.homeworkAction(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        parseInput(homeworkActionSchema, req.body),
      ),
    }),
  );
  router.get('/:id', async (req, res) =>
    res.json({
      course: publicCourse(
        await service.course(req.gotitAuth!, parseInput(uuidSchema, req.params.id)),
      ),
    }),
  );
  router.get('/:id/units/:unitKey/words', async (req, res) =>
    res.json(
      await service.unitWords(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        parseInput(
          z
            .string()
            .min(1)
            .max(70)
            .regex(/^[a-z0-9-]+$/),
          req.params.unitKey,
        ),
      ),
    ),
  );
  router.delete('/:id', async (req, res) => {
    await service.deleteCourse(req.gotitAuth!, parseInput(uuidSchema, req.params.id));
    res.status(204).end();
  });
  router.post('/:id/realtime-session', async (req, res) =>
    res.status(201).json({
      realtime: await service.realtimeSession(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
      ),
    }),
  );
  router.post('/:id/turns', async (req, res) =>
    res.json({
      course: await service.turn(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        parseInput(courseTurnSchema, req.body),
      ),
    }),
  );
  router.put('/:id/preferences', async (req, res) =>
    res.json({
      course: await service.updatePreferences(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        parseInput(commandSchema.extend({ preferences: coursePreferencesSchema }), req.body),
      ),
    }),
  );
  router.post('/:id/preferences/approve', async (req, res) =>
    res.json({
      course: await service.approvePreferences(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        parseInput(commandSchema, req.body),
      ),
    }),
  );
  router.post('/:id/plan', async (req, res) =>
    res.json({
      course: await service.plan(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        parseInput(commandSchema, req.body),
      ),
    }),
  );
  router.post('/:id/activate', async (req, res) =>
    res.json({
      course: await service.activate(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        parseInput(commandSchema.extend({ version: z.number().int().positive() }), req.body),
      ),
    }),
  );
  return router;
}
