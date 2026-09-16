import { Router } from 'express';
import { z } from 'zod';
import { parseInput, uuidSchema } from '../capture/capture.validation.js';
import {
  listSchema,
  editSchema,
  bulkSchema,
  tagSchema,
  itemTagsSchema,
  examplesSchema,
  pageSchema,
} from './library.validation.js';
import type { LibraryRepository } from './library.repository.js';
export function createLibraryRoutes(service: LibraryRepository) {
  const router = Router();
  router.get('/', async (req, res) =>
    res.json({
      ...(await service.list(req.gotitAuth!, parseInput(listSchema, req.query))),
      requestId: req.id,
    }),
  );
  router.post('/bulk', async (req, res) =>
    res.json({
      ...(await service.bulk(req.gotitAuth!, parseInput(bulkSchema, req.body))),
      requestId: req.id,
    }),
  );
  router.patch('/:id', async (req, res) =>
    res.json({
      learningItem: await service.edit(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        parseInput(editSchema, req.body),
      ),
      requestId: req.id,
    }),
  );
  router.delete('/:id', async (req, res) =>
    res.json({
      ...(await service.bulk(req.gotitAuth!, {
        ids: [parseInput(uuidSchema, req.params.id)],
        action: 'delete',
      })),
      requestId: req.id,
    }),
  );
  router.post('/:id/restore', async (req, res) =>
    res.json({
      ...(await service.bulk(req.gotitAuth!, {
        ids: [parseInput(uuidSchema, req.params.id)],
        action: 'restore',
      })),
      requestId: req.id,
    }),
  );
  router.post('/:id/mastery', async (req, res) => {
    const input = parseInput(z.object({ mastered: z.boolean() }).strict(), req.body);
    res.json({
      ...(await service.bulk(req.gotitAuth!, {
        ids: [parseInput(uuidSchema, req.params.id)],
        action: input.mastered ? 'mark_mastered' : 'return_to_learning',
      })),
      requestId: req.id,
    });
  });
  router.put('/:id/tags', async (req, res) =>
    res.json({
      ...(await service.setTags(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        parseInput(itemTagsSchema, req.body).tagIds,
      )),
      requestId: req.id,
    }),
  );
  router.get('/:id/occurrences', async (req, res) => {
    const page = parseInput(pageSchema, req.query);
    res.json({
      ...(await service.occurrences(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        page.limit,
        page.cursor,
      )),
      requestId: req.id,
    });
  });
  router.get('/:id/translations', async (req, res) => {
    const page = parseInput(
      pageSchema.extend({ includeHistorical: z.enum(['true', 'false']).default('false') }),
      req.query,
    );
    res.json({
      ...(await service.translations(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        page.limit,
        page.cursor,
        page.includeHistorical === 'true',
      )),
      requestId: req.id,
    });
  });
  router.get('/:id/examples', async (req, res) =>
    res.json({
      examples: await service.examples(req.gotitAuth!, parseInput(uuidSchema, req.params.id)),
      requestId: req.id,
    }),
  );
  router.put('/:id/examples', async (req, res) =>
    res.json({
      examples: await service.examples(
        req.gotitAuth!,
        parseInput(uuidSchema, req.params.id),
        parseInput(examplesSchema, req.body).examples,
      ),
      requestId: req.id,
    }),
  );
  return router;
}
export function createTagRoutes(service: LibraryRepository) {
  const router = Router();
  router.get('/', async (req, res) => {
    const page = parseInput(pageSchema, req.query);
    res.json({
      ...(await service.tags(req.gotitAuth!, page.limit, page.cursor)),
      requestId: req.id,
    });
  });
  router.post('/', async (req, res) =>
    res.status(201).json({
      tag: await service.saveTag(req.gotitAuth!, parseInput(tagSchema, req.body).name),
      requestId: req.id,
    }),
  );
  router.patch('/:id', async (req, res) =>
    res.json({
      tag: await service.saveTag(
        req.gotitAuth!,
        parseInput(tagSchema, req.body).name,
        parseInput(uuidSchema, req.params.id),
      ),
      requestId: req.id,
    }),
  );
  router.delete('/:id', async (req, res) =>
    res.json({
      ...(await service.deleteTag(req.gotitAuth!, parseInput(uuidSchema, req.params.id))),
      requestId: req.id,
    }),
  );
  return router;
}
