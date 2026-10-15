import { Router, type Request, type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { AppError } from '../../shared/errors/app-error.js';
import { ProductAdminService, type AdminActor } from './admin.service.js';
import {
  listSchema,
  saveSchema,
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
  for (const resource of [
    'prompts',
    'policies',
    'programs',
    'assignments',
    'support',
    'usage',
    'quotas',
    'audit',
  ] as const) {
    router.get(`/${resource}`, async (req, res) =>
      res.json(await service.list(actor(req), resource, listSchema.parse(req.query))),
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
        saveSchema.parse(req.body),
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
  const validationErrors: ErrorRequestHandler = (error, _req, _res, next) =>
    next(
      error instanceof z.ZodError
        ? new AppError(400, 'VALIDATION_ERROR', 'Request validation failed')
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
