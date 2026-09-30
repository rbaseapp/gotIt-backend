import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../shared/errors/app-error.js';
import { preferencePatchSchema, subscriptionSchema } from './notification.policy.js';
import type { NotificationService } from './notification.service.js';

export function createNotificationRoutes(service: NotificationService) {
  const router = Router();
  router.get('/config', (_req, res) => {
    res.json(service.config());
  });
  router.get('/preferences', async (req, res, next) => {
    try {
      res.json({ preferences: await service.preferences(req.gotitAuth!), requestId: req.id });
    } catch (error) {
      next(error);
    }
  });
  router.patch('/preferences', async (req, res, next) => {
    try {
      const parsed = preferencePatchSchema.safeParse(req.body);
      if (!parsed.success)
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid notification preferences');
      if ((parsed.data.practiceEmail || parsed.data.systemEmail) && !req.gotitVerifiedEmail)
        throw new AppError(409, 'VERIFIED_EMAIL_REQUIRED', 'A verified email is required');
      const config = service.config();
      if ((parsed.data.practiceEmail || parsed.data.systemEmail) && !config.emailAvailable)
        throw new AppError(503, 'EMAIL_NOT_CONFIGURED', 'Email delivery is unavailable');
      if ((parsed.data.practicePush || parsed.data.systemPush) && !config.pushAvailable)
        throw new AppError(503, 'PUSH_NOT_CONFIGURED', 'Push delivery is unavailable');
      const preferences = await service.patchPreferences(
        req.gotitAuth!,
        parsed.data,
        req.gotitVerifiedEmail,
      );
      res.json({ preferences, requestId: req.id });
    } catch (error) {
      next(error);
    }
  });
  router.post('/push-subscriptions', async (req, res, next) => {
    try {
      const parsed = subscriptionSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid push subscription');
      await service.addSubscription(req.gotitAuth!, parsed.data);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  router.delete('/push-subscriptions', async (req, res, next) => {
    try {
      const parsed = z
        .object({ endpoint: z.string().url().max(2048) })
        .strict()
        .safeParse(req.body);
      if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Invalid push subscription');
      await service.removeSubscription(req.gotitAuth!, parsed.data.endpoint);
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });
  return router;
}
