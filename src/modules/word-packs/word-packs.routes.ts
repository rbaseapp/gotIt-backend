import { Router, type RequestHandler } from 'express';
import { parseInput, uuidSchema } from '../capture/capture.validation.js';
import type { WordPackRepository } from './word-packs.repository.js';
import {
  addSchema,
  catalogQuerySchema,
  knownSchema,
  removalSchema,
} from './word-packs.validation.js';
import type { WordPackStudyService } from './word-pack-study.service.js';
import { z } from 'zod';

export function createWordPackRoutes(
  service: WordPackRepository,
  requireWrite: RequestHandler,
  study?: WordPackStudyService,
  requireStudy: RequestHandler = requireWrite,
) {
  const router = Router();
  if (study) {
    for (const kind of ['image', 'example'] as const) {
      router.post('/:id/entries/:entryId/' + kind, requireStudy, async (req, res) => {
        parseInput(z.object({}).strict(), req.body);
        res.set('Cache-Control', 'private, no-store').json({
          ...(await study[kind](
            req.gotitAuth!,
            parseInput(uuidSchema, req.params.id),
            parseInput(uuidSchema, req.params.entryId),
          )),
          requestId: req.id,
        });
      });
    }
  }
  router.get('/', async (req, res) =>
    res.json({
      ...(await service.list(req.gotitAuth!, parseInput(catalogQuerySchema, req.query))),
      requestId: req.id,
    }),
  );
  router.get('/:id', async (req, res) =>
    res.json({
      ...(await service.detail(req.gotitAuth!, parseInput(uuidSchema, req.params.id))),
      requestId: req.id,
    }),
  );
  router.get('/:id/entries/:entryId/image', async (req, res) =>
    res.set('Cache-Control', 'private, no-store').json({
      ...(await service.image(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        parseInput(uuidSchema, req.params.entryId),
      )),
      requestId: req.id,
    }),
  );
  router.post('/:id/add', requireWrite, async (req, res) =>
    res.status(201).json({
      ...(await service.add(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        parseInput(addSchema, req.body),
      )),
      requestId: req.id,
    }),
  );
  router.put('/:id/known', requireWrite, async (req, res) =>
    res.json({
      ...(await service.setKnown(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        parseInput(knownSchema, req.body),
      )),
      requestId: req.id,
    }),
  );
  router.delete('/:id', async (req, res) =>
    res.json({
      ...(await service.remove(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        parseInput(removalSchema, req.query),
      )),
      requestId: req.id,
    }),
  );
  return router;
}
