import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { parseInput } from '../capture/capture.validation.js';
import type { CurriculumService } from './curriculum.service.js';

const command = z.object({ eventId: z.uuid(), revision: z.number().int().positive() });
const activityId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[\w:-]+$/u);
const id = z.uuid();
const band = z.enum(['Pre-A1', 'A1', 'A2', 'B1', 'B2', 'C1']);
const skill = z.object({ band, score: z.number().min(0).max(1) }).strict();
const interestIds = [
  'travel',
  'business',
  'tech',
  'series',
  'food',
  'sport',
  'studies',
  'news',
  'music',
] as const;
const priorityIds = ['vocabulary', 'grammar', 'speaking', 'listening', 'writing', 'teacher'] as const;
const placementSchema = z
  .object({
    eventId: z.uuid(),
    theta: z.number().min(0).max(84),
    startUnit: z.number().int().min(1).max(84),
    literacy: z.enum(['starting', 'developing', 'independent']),
    minutesPerDay: z.number().int().min(5).max(120),
    goal: z.enum(['travel', 'work', 'study', 'talk', 'abroad', 'other']),
    deadlineMonths: z.number().int().min(0).max(24),
    reliability: z.number().min(0).max(1),
    skills: z
      .object({ vocabulary: skill, reading: skill.nullable(), listening: skill.nullable() })
      .strict(),
    knownWords: z.array(z.string().regex(/^[A-Za-z]{2,40}$/u)).max(1500),
    profile: z
      .object({
        selfLevel: z
          .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
          .optional(),
        interests: z.array(z.enum(interestIds)).max(3).optional(),
        priorities: z.array(z.enum(priorityIds)).max(2).optional(),
        targetBand: band.optional(),
        talk: z
          .object({
            correct: z.number().int().min(0).max(8),
            total: z.number().int().min(1).max(8),
            unknown: z.number().int().min(0).max(8).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
  })
  .strict();
const pathId = z.string().regex(/^[\w-]{1,40}$/u);
export function createCurriculumRoutes(
  service: CurriculumService,
  requirePractice: RequestHandler,
  requireAi: RequestHandler,
) {
  const router = Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });
  router.get('/catalog', async (_req, res) => res.json(await service.catalog()));
  router.get('/', async (req, res) => res.json(await service.get(req.gotitAuth!)));
  // Placement is open to every signed-in learner, including free accounts. It stores a level and a plan;
  // the lesson content itself (units, phonics, teacher scripts, articles) is behind the practice and
  // curriculum entitlements below, so placing yourself never opens paid content.
  router.post('/placement', async (req, res) =>
    res.json(await service.place(req.gotitAuth!, parseInput(placementSchema, req.body))),
  );
  router.post('/path-choices', requirePractice, async (req, res) =>
    res.json(
      await service.pathChoice(
        req.gotitAuth!,
        parseInput(
          command
            .extend({ unitId: pathId, activityId: activityId.optional(), skipped: z.boolean() })
            .strict(),
          req.body,
        ),
      ),
    ),
  );
  router.post('/enroll', requirePractice, async (req, res) =>
    res.json(
      await service.enroll(
        req.gotitAuth!,
        parseInput(
          z
            .object({
              eventId: z.uuid(),
              minutes: z.union([
                z.literal(10),
                z.literal(20),
                z.literal(30),
                z.literal(45),
                z.literal(60),
              ]),
              literacy: z.enum(['starting', 'developing', 'independent']),
            })
            .strict(),
          req.body,
        ),
      ),
    ),
  );
  router.get('/units/:id', requirePractice, async (req, res) =>
    res.json(await service.unit(req.gotitAuth!, parseInput(pathId, req.params.id))),
  );
  router.post('/exposures', requirePractice, async (req, res) =>
    res.json(
      await service.expose(
        req.gotitAuth!,
        parseInput(command.extend({ targetIds: z.array(pathId).min(1).max(6) }).strict(), req.body),
      ),
    ),
  );
  router.post('/work', requirePractice, async (req, res) =>
    res.json(
      await service.saveWork(
        req.gotitAuth!,
        parseInput(
          command
            .extend({
              activityId,
              draft: z.string().max(12000).optional(),
              cursor: z.number().int().min(0).max(200).optional(),
            })
            .strict(),
          req.body,
        ),
      ),
    ),
  );
  router.post('/heartbeat', requirePractice, async (req, res) =>
    res.json(
      await service.heartbeat(
        req.gotitAuth!,
        parseInput(z.object({ eventId: z.uuid(), activityId }).strict(), req.body),
      ),
    ),
  );
  router.post('/attempts', requireAi, async (req, res) =>
    res.json(
      await service.start(
        req.gotitAuth!,
        parseInput(command.extend({ activityId }).strict(), req.body),
      ),
    ),
  );
  router.get('/attempts/:id', requirePractice, async (req, res) =>
    res.json(await service.getAttempt(req.gotitAuth!, parseInput(id, req.params.id))),
  );
  router.post('/hints', requirePractice, async (req, res) =>
    res.json(
      await service.hint(
        req.gotitAuth!,
        parseInput(
          command.extend({ attemptId: id, cursor: z.number().int().min(0).max(200) }).strict(),
          req.body,
        ),
      ),
    ),
  );
  router.post('/answers', requireAi, async (req, res) =>
    res.json(
      await service.answer(
        req.gotitAuth!,
        parseInput(
          command
            .extend({
              attemptId: id,
              cursor: z.number().int().min(0).max(200),
              answer: z.string().max(12000),
              choiceId: z.string().max(120).optional(),
              modality: z.enum(['typed', 'transcribed']),
              transcriptionId: id.optional(),
            })
            .strict(),
          req.body,
        ),
      ),
    ),
  );
  router.post('/transcriptions', requireAi, async (req, res) => {
    const input = parseInput(
      z
        .object({
          attemptId: id,
          cursor: z.number().int().min(0).max(200),
          audioBase64: z.string().min(60).max(3_900_000),
        })
        .strict(),
      req.body,
    );
    res.json(
      await service.transcribe(req.gotitAuth!, input.attemptId, input.cursor, input.audioBase64),
    );
  });
  router.post('/audio', requireAi, async (req, res) => {
    const input = parseInput(
      z
        .object({
          attemptId: id,
          cursor: z.number().int().min(0).max(200),
          part: z.number().int().min(0).max(30).default(0),
        })
        .strict(),
      req.body,
    );
    res.json(await service.attemptAudio(req.gotitAuth!, input.attemptId, input.cursor, input.part));
  });
  router.post('/teaching-audio', requireAi, async (req, res) =>
    res.json(
      await service.teachingAudio(
        req.gotitAuth!,
        parseInput(
          z
            .object({
              kind: z.enum(['target', 'phonics']),
              id: pathId,
              index: z.number().int().min(0).max(100),
            })
            .strict(),
          req.body,
        ),
      ),
    ),
  );
  router.get('/phonics/:id', requirePractice, async (req, res) =>
    res.json(await service.phonics(req.gotitAuth!, parseInput(pathId, req.params.id))),
  );
  router.get('/unseen/:id', requirePractice, async (req, res) =>
    res.json(await service.unseen(req.gotitAuth!, parseInput(pathId, req.params.id))),
  );
  router.get('/teacher/:id', requirePractice, async (req, res) =>
    res.json(await service.teacher(req.gotitAuth!, parseInput(pathId, req.params.id))),
  );
  router.post('/teacher-turns', requireAi, async (req, res) =>
    res.json(
      await service.teacherTurn(
        req.gotitAuth!,
        parseInput(
          command
            .extend({ lessonId: pathId, answer: z.string().trim().min(1).max(12000) })
            .strict(),
          req.body,
        ),
      ),
    ),
  );
  router.post('/articles', requireAi, async (req, res) =>
    res.json(await service.generateArticle(req.gotitAuth!, parseInput(command.strict(), req.body))),
  );
  router.get('/articles/:id', requirePractice, async (req, res) =>
    res.json(await service.article(req.gotitAuth!, parseInput(id, req.params.id))),
  );
  return router;
}
