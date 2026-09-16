import { Router } from 'express';
import { z } from 'zod';
import { parseInput } from '../capture/capture.validation.js';
import type { DashboardService } from './dashboard.service.js';
export function createDashboardRoutes(service: DashboardService) {
  const router = Router();
  router.get('/', async (req, res) =>
    res.json({ ...(await service.dashboard(req.gotitAuth!)), requestId: req.id }),
  );
  router.get('/activity', async (req, res) => {
    const input = parseInput(
      z.object({ days: z.coerce.number().int().min(1).max(366).default(30) }).strict(),
      req.query,
    );
    res.json({ ...(await service.activity(req.gotitAuth!, input.days)), requestId: req.id });
  });
  return router;
}
export function createGamificationRoutes(service: DashboardService) {
  const router = Router();
  router.get('/', async (req, res) =>
    res.json({ ...(await service.gamification(req.gotitAuth!)), requestId: req.id }),
  );
  return router;
}
