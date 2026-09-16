import type { Request, Response } from 'express';
import { AppError } from '../../shared/errors/app-error.js';
import type { CaptureService } from './capture.service.js';
import { parseInput, previewSchema, saveSchema, uuidSchema } from './capture.validation.js';

function scope(request: Request) {
  if (!request.gotitAuth)
    throw new AppError(500, 'AUTH_CONTEXT_MISSING', 'Authenticated context is missing');
  return request.gotitAuth;
}
export function createCaptureController(service: CaptureService) {
  return {
    preview: async (request: Request, response: Response) => {
      const preview = await service.preview(
        scope(request),
        parseInput(previewSchema, request.body),
      );
      response.json({ preview, requestId: request.id });
    },
    save: async (request: Request, response: Response) => {
      const key = parseInput(uuidSchema, request.header('idempotency-key'));
      const input = parseInput(saveSchema, request.body);
      if (input.clientEventId && input.clientEventId !== key)
        throw new AppError(400, 'VALIDATION_ERROR', 'Body event key must match Idempotency-Key');
      const result = await service.save(scope(request), key, input);
      response
        .set('Idempotency-Replayed', String(result.replayed))
        .status(result.httpStatus)
        .json({ capture: result.capture, requestId: request.id });
    },
    detail: async (request: Request, response: Response) => {
      const id = parseInput(uuidSchema, request.params.id);
      response.json({
        learningItem: await service.getDetail(scope(request), id),
        requestId: request.id,
      });
    },
  };
}
