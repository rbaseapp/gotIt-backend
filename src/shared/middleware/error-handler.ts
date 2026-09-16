import type { ErrorRequestHandler } from 'express';
import { AppError } from '../errors/app-error.js';

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  // Parser errors may carry the raw body and include input in their message.
  // Replace only recognized parser failures before logging or responding.
  error = normalizeParserError(error) ?? error;

  if (error instanceof AppError) {
    request.log?.warn(
      {
        requestId: request.id,
        errorCode: error.code,
      },
      'Request failed',
    );

    response.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
      requestId: request.id,
    });
    return;
  }

  request.log?.error(
    {
      requestId: request.id,
    },
    'Unhandled request error',
  );

  response.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
    },
    requestId: request.id,
  });
};

function normalizeParserError(error: unknown): AppError | undefined {
  if (!error || typeof error !== 'object' || !('type' in error) || !('status' in error)) {
    return undefined;
  }

  if (error.type === 'entity.parse.failed' && error.status === 400) {
    return new AppError(400, 'VALIDATION_ERROR', 'Request body must be valid JSON');
  }

  if (error.type === 'entity.too.large' && error.status === 413) {
    return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds the size limit');
  }

  return undefined;
}
