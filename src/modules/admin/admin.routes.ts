import { Router, type Request, type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../../shared/errors/app-error.js';
import { ProductAdminService, type AdminActor } from './admin.service.js';
import {
  unitIdSchema,
  unitSaveSchema,
  lessonPreviewSchema,
  unitPreviewSchema,
} from './admin.programs.js';
import { learnerPageSchema, learnerSectionSchema, learnerProfileSchema } from './admin.learner.js';
import { learnerSettingsSchema } from './admin.learner.js';
import { conceptSaveSchema } from '../concepts/concepts.schema.js';
import { regenerateConceptSchema } from './admin.concept-regeneration.js';
import { wordListSchema, wordSectionSchema } from './admin.words.js';
import {
  listSchema,
  usageListSchema,
  saveSchema,
  assignmentSaveSchema,
  publishSchema,
  assignSchema,
  supportCreateSchema,
  supportUpdateSchema,
  quotaGrantSchema,
  generateSchema,
} from './admin.schemas.js';
const assignmentId = z
  .string()
  .regex(/^[0-9a-f-]{36}_[0-9a-f-]{36}$/i)
  .refine((value) => value.split('_').every((part) => z.uuid().safeParse(part).success));

export function createProductAdminRouter(service: ProductAdminService) {
  const router = Router();
  const actor = (req: Request): AdminActor => ({
    ...req.gotitAuth!,
    token: req.gotitCoreAccessToken!,
    requestId: String(req.id),
    ...(req.get('x-admin-step-up') ? { stepUp: req.get('x-admin-step-up')! } : {}),
  });
  router.use((req, _res, next) => {
    if (req.gotitAuth?.role !== 'admin' || !req.gotitVerifiedEmail)
      throw new AppError(403, 'ADMIN_REQUIRED', 'An active, verified administrator is required');
    next();
  });
  router.get('/access', async (req, res) => res.json(await service.access(actor(req))));
  router.get('/words', async (req, res) => res.json(await service.words.list(actor(req), wordListSchema.parse(req.query))));
  router.get('/words/:id', async (req, res) => res.json(await service.words.list(actor(req), wordListSchema.parse({}), z.uuid().parse(req.params.id))));
  router.get('/word-images/:id', async (req, res) => res.json(await service.words.image(actor(req), z.uuid().parse(req.params.id))));
  router.get('/words/:id/:section', async (req, res) => res.json(await service.words.section(actor(req), z.uuid().parse(req.params.id), wordSectionSchema.parse(req.params.section), listSchema.parse(req.query))));
  router.get('/learners/:id/courses/:courseId', async (req, res) =>
    res.json(
      await service.learnerCourse(
        actor(req),
        z.uuid().parse(req.params.id),
        z.uuid().parse(req.params.courseId),
      ),
    ),
  );
  router.get('/concepts', async (req, res) =>
    res.json(await service.concepts.list(actor(req), listSchema.parse(req.query))),
  );
  router.get('/concepts/:id', async (req, res) =>
    res.json(
      await service.concepts.list(actor(req), listSchema.parse({}), z.uuid().parse(req.params.id)),
    ),
  );
  router.post('/concepts', async (req, res) =>
    res
      .status(201)
      .json(await service.concepts.save(actor(req), null, conceptSaveSchema.parse(req.body))),
  );
  router.patch('/concepts/:id', async (req, res) =>
    res.json(
      await service.concepts.save(
        actor(req),
        z.uuid().parse(req.params.id),
        conceptSaveSchema.parse(req.body),
      ),
    ),
  );
  router.post('/concepts/:id/generate', async (req, res) =>
    res.json(
      await service.concepts.generate(
        actor(req),
        z.uuid().parse(req.params.id),
        generateSchema.parse(req.body),
      ),
    ),
  );
  router.post('/concepts/:id/regenerate', async (req, res) =>
    res.json(await service.concepts.regenerate(actor(req), z.uuid().parse(req.params.id), regenerateConceptSchema.parse(req.body))),
  );
  for (const resource of ['catalog-units', 'learner-units'] as const) {
    router.get(`/${resource}`, async (req, res) =>
      res.json(
        await service.programContent.units(
          actor(req),
          listSchema.parse(req.query),
          undefined,
          resource === 'learner-units',
        ),
      ),
    );
    router.get(`/${resource}/:id`, async (req, res) =>
      res.json(
        await service.programContent.units(
          actor(req),
          listSchema.parse({}),
          unitIdSchema.parse(req.params.id),
          resource === 'learner-units',
        ),
      ),
    );
    router.patch(`/${resource}/:id`, async (req, res) =>
      res.json(
        await service.programContent.saveUnit(
          actor(req),
          unitIdSchema.parse(req.params.id),
          unitSaveSchema.parse(req.body),
        ),
      ),
    );
  }
  router.get('/lessons', async (req, res) =>
    res.json(await service.programContent.lessons(actor(req), listSchema.parse(req.query))),
  );
  router.get('/lessons/:id', async (req, res) =>
    res.json(
      await service.programContent.lessons(
        actor(req),
        listSchema.parse({}),
        z.uuid().parse(req.params.id),
      ),
    ),
  );
  router.post('/programs/preview', async (req, res) =>
    res.json(await service.programContent.preview(actor(req), lessonPreviewSchema.parse(req.body))),
  );
  router.post('/units/preview', async (req, res) =>
    res.json(
      await service.programContent.previewUnit(actor(req), unitPreviewSchema.parse(req.body)),
    ),
  );
  router.get('/learners/:id/:section', async (req, res) =>
    res.json(
      await service.learner(
        actor(req),
        z.uuid().parse(req.params.id),
        learnerSectionSchema.parse(req.params.section),
        learnerPageSchema.parse(req.query),
      ),
    ),
  );
  router.patch('/learners/:id/profile', async (req, res) =>
    res.json(
      await service.updateLearner(
        actor(req),
        z.uuid().parse(req.params.id),
        learnerProfileSchema.parse(req.body),
      ),
    ),
  );
  router.patch('/learners/:id/settings', async (req, res) =>
    res.json(
      await service.updateLearnerSettings(
        actor(req),
        z.uuid().parse(req.params.id),
        learnerSettingsSchema.parse(req.body),
      ),
    ),
  );
  router.post('/prompts/preview', async (req, res) =>
    res.json(await service.previewPrompt(actor(req), req.body)),
  );
  for (const resource of [
    'prompts',
    'policies',
    'programs',
    'assignments',
    'catalog-programs',
    'support',
    'usage',
    'quotas',
    'audit',
  ] as const) {
    router.get(`/${resource}`, async (req, res) =>
      res.json(await service.list(actor(req), resource, (resource === 'usage' ? usageListSchema : listSchema).parse(req.query))),
    );
    router.get(`/${resource}/:id`, async (req, res) =>
      res.json(
        await service.list(
          actor(req),
          resource,
          listSchema.parse({}),
          (resource === 'assignments' ? assignmentId : z.uuid()).parse(req.params.id),
        ),
      ),
    );
  }
  for (const resource of ['prompts', 'policies', 'programs'] as const) {
    router.post(`/${resource}`, async (req, res) =>
      res
        .status(201)
        .json(await service.save(actor(req), resource, null, saveSchema.parse(req.body))),
    );
    router.patch(`/${resource}/:id`, async (req, res) =>
      res.json(
        await service.save(
          actor(req),
          resource,
          z.uuid().parse(req.params.id),
          saveSchema.parse(req.body),
        ),
      ),
    );
    router.post(`/${resource}/:id/publish`, async (req, res) =>
      res.json(
        await service.publish(
          actor(req),
          resource,
          z.uuid().parse(req.params.id),
          publishSchema.parse(req.body),
        ),
      ),
    );
  }
  router.post('/programs/:id/assign', async (req, res) =>
    res
      .status(201)
      .json(
        await service.assign(
          actor(req),
          z.uuid().parse(req.params.id),
          assignSchema.parse(req.body),
        ),
      ),
  );
  router.post('/programs/:id/generate', async (req, res) =>
    res.json(
      await service.generate(
        actor(req),
        z.uuid().parse(req.params.id),
        generateSchema.parse(req.body),
      ),
    ),
  );
  router.patch('/assignments/:id', async (req, res) =>
    res.json(
      await service.updateAssignment(
        actor(req),
        assignmentId.parse(req.params.id),
        assignmentSaveSchema.parse(req.body),
      ),
    ),
  );
  router.post('/assignments/:id/activate', async (req, res) =>
    res.json(
      await service.activateAssignment(
        actor(req),
        assignmentId.parse(req.params.id),
        generateSchema.parse(req.body),
      ),
    ),
  );
  router.post('/support', async (req, res) =>
    res
      .status(201)
      .json(await service.createSupport(actor(req), supportCreateSchema.parse(req.body))),
  );
  router.patch('/support/:id', async (req, res) =>
    res.json(
      await service.updateSupport(
        actor(req),
        z.uuid().parse(req.params.id),
        supportUpdateSchema.parse(req.body),
      ),
    ),
  );
  router.post('/usage/credits', async (req, res) =>
    res.status(201).json(await service.grantQuota(actor(req), quotaGrantSchema.parse(req.body))),
  );
  const validationErrors: ErrorRequestHandler = (error, req, _res, next) =>
    next(
      error instanceof z.ZodError
        ? req.path.startsWith('/prompts')
          ? new AppError(
              400,
              'PROMPT_CONFIG_INVALID',
              `בדקו את הגדרות הפרומפט: ${error.issues
                .slice(0, 5)
                .map((issue) => `${issue.path.join('.') || 'content'}: ${issue.message}`)
                .join('; ')}`.slice(0, 1000),
            )
          : new AppError(400, 'VALIDATION_ERROR', 'Request validation failed')
        : error,
    );
  router.use(validationErrors);
  return router;
}

export function createLearnerSupportRouter(service: ProductAdminService) {
  const router = Router();
  const actor = (req: Request): AdminActor => ({
    ...req.gotitAuth!,
    token: req.gotitCoreAccessToken!,
    requestId: String(req.id),
    ...(req.get('x-admin-step-up') ? { stepUp: req.get('x-admin-step-up')! } : {}),
  });
  const subject = z.string().trim().min(3).max(200),
    message = z.string().trim().min(1).max(5000);
  router.get('/tickets', async (req, res) => res.json(await service.learnerTickets(actor(req))));
  router.get('/tickets/:id', async (req, res) =>
    res.json(await service.learnerTickets(actor(req), z.uuid().parse(req.params.id))),
  );
  router.post('/tickets', async (req, res) => {
    const input = z.object({ operationId: z.uuid(), subject, message }).strict().parse(req.body);
    await service.profilesForLearner(actor(req));
    res.status(201).json(await service.submitSupport(actor(req), input));
  });
  router.post('/tickets/:id/reply', async (req, res) =>
    res.json(
      await service.replySupport(
        actor(req),
        z.uuid().parse(req.params.id),
        z
          .object({
            operationId: z.uuid(),
            expectedRevision: z.number().int().nonnegative(),
            message,
          })
          .strict()
          .parse(req.body),
      ),
    ),
  );
  const errors: ErrorRequestHandler = (error, _req, _res, next) =>
    next(
      error instanceof z.ZodError
        ? new AppError(400, 'VALIDATION_ERROR', 'Request validation failed')
        : error,
    );
  router.use(errors);
  return router;
}
