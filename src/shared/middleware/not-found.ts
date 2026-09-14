import type { Request, Response } from 'express';

export function notFoundHandler(request: Request, response: Response) {
  response.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found',
    },
    requestId: request.id,
  });
}
