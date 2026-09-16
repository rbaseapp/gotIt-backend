import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

const REQUEST_ID_HEADER = 'x-request-id';

export function requestIdMiddleware(request: Request, response: Response, next: NextFunction) {
  const incoming = request.header(REQUEST_ID_HEADER)?.trim();
  const requestId = incoming && incoming.length <= 200 ? incoming : randomUUID();

  request.id = requestId;
  response.setHeader(REQUEST_ID_HEADER, requestId);

  next();
}
