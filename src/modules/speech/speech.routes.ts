import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { languageSchema, parseInput, uuidSchema } from '../capture/capture.validation.js';
import type { SpeechService } from './speech.service.js';
const assessmentSchema = z
  .object({
    exerciseId: uuidSchema,
    // Optional during the backend-first rollout; current clients always send it.
    languageCode: languageSchema.optional(),
    audioBase64: z
      .string()
      .min(1)
      .max(666668)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  })
  .strict();
export function createSpeechItemRoutes(service: SpeechService, requireAudio: RequestHandler) {
  const router = Router();
  router.get('/:id/audio', requireAudio, async (req, res) => {
    const result = await service.audio(req.gotitAuth!, parseInput(uuidSchema, req.params.id));
    res.type(result.contentType).send(result.audio);
  });
  return router;
}
export function createPronunciationRoutes(
  service: SpeechService,
  requirePronunciation: RequestHandler,
) {
  const router = Router();
  router.post('/assessments', requirePronunciation, async (req, res) => {
    const input = parseInput(assessmentSchema, req.body);
    const result = await service.assess(
      req.gotitAuth!,
      parseInput(uuidSchema, req.get('Idempotency-Key')),
      input.exerciseId,
      input.languageCode,
      Buffer.from(input.audioBase64, 'base64'),
    );
    res.status(result.replayed ? 200 : 201).json({ ...result, requestId: req.id });
  });
  return router;
}
