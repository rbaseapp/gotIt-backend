import { Router } from 'express';
import { z } from 'zod';
import { parseInput, uuidSchema } from '../capture/capture.validation.js';
import type { SpeechService } from './speech.service.js';
const assessmentSchema = z
  .object({
    exerciseId: uuidSchema,
    audioBase64: z
      .string()
      .min(1)
      .max(666668)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  })
  .strict();
export function createSpeechItemRoutes(service: SpeechService) {
  const router = Router();
  router.get('/:id/audio', async (req, res) => {
    const result = await service.audio(req.gotitAuth!, parseInput(uuidSchema, req.params.id));
    res.type(result.contentType).send(result.audio);
  });
  return router;
}
export function createPronunciationRoutes(service: SpeechService) {
  const router = Router();
  router.post('/assessments', async (req, res) => {
    const input = parseInput(assessmentSchema, req.body);
    const result = await service.assess(
      req.gotitAuth!,
      parseInput(uuidSchema, req.get('Idempotency-Key')),
      input.exerciseId,
      Buffer.from(input.audioBase64, 'base64'),
    );
    res.status(result.replayed ? 200 : 201).json({ ...result, requestId: req.id });
  });
  return router;
}
