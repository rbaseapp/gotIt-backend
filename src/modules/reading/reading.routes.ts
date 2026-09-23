import { Router, type RequestHandler } from 'express';
import { parseInput, uuidSchema } from '../capture/capture.validation.js';
import { pageSchema } from '../library/library.validation.js';
import { publicationSchema, readingInputSchema } from './reading.validation.js';
import type { ReadingService } from './reading.service.js';
export function createReadingRoutes(service: ReadingService, requireGeneration: RequestHandler) {
  const router = Router();
  router.get('/quota', async (req, res) =>
    res.json({ quota: await service.quotaStatus(req.gotitAuth!), requestId: req.id }),
  );
  router.post('/preview', requireGeneration, async (req, res) =>
    res.json({
      ...(await service.preview(req.gotitAuth!, parseInput(readingInputSchema, req.body))),
      requestId: req.id,
    }),
  );
  router.post('/', requireGeneration, async (req, res) => {
    const result = await service.open(
      req.gotitAuth!,
      parseInput(uuidSchema, req.get('Idempotency-Key')),
      parseInput(publicationSchema, req.body).publicationToken,
    );
    res.status(result.replayed ? 200 : 201).json({ ...result, requestId: req.id });
  });
  router.get('/', async (req, res) => {
    const page = parseInput(pageSchema, req.query);
    res.json({
      ...(await service.list(req.gotitAuth!, page.limit, page.cursor)),
      requestId: req.id,
    });
  });
  router.get('/:id', async (req, res) =>
    res.json({
      reading: await service.detail(req.gotitAuth!, parseInput(uuidSchema, req.params.id)),
      requestId: req.id,
    }),
  );
  router.delete('/:id', requireGeneration, async (req, res) =>
    res.json({
      ...(await service.remove(req.gotitAuth!, parseInput(uuidSchema, req.params.id))),
      requestId: req.id,
    }),
  );
  return router;
}
