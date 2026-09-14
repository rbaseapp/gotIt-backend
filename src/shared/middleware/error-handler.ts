import type { ErrorRequestHandler } from 'express';
import { AppError } from '../errors/app-error.js';

export const errorHandler: ErrorRequestHandler = (
  error,
  request,
  response,
  _next,
) => {
  if (error instanceof AppError) {
    request.log?.warn(
      {
        err: error,
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
      err: error,
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
