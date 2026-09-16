import type { RequestHandler } from 'express';
import { AppError } from '../errors/app-error.js';
export function validateOrigins(values: string[]) {
  return values.map((value) => {
    const url = new URL(value);
    if (
      !['https:', 'http:', 'chrome-extension:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.hostname ||
      (url.pathname && url.pathname !== '/') ||
      value === '*' ||
      value === 'null'
    )
      throw new Error('CORS origins must be exact web or extension origins');
    return url.protocol === 'chrome-extension:' ? `chrome-extension://${url.hostname}` : url.origin;
  });
}
export function createCors(origins: string[] = []): RequestHandler {
  const allowed = new Set(validateOrigins(origins));
  return (req, res, next) => {
    const origin = req.get('origin');
    if (!origin) {
      next();
      return;
    }
    res.vary('Origin');
    if (!allowed.has(origin)) {
      next(new AppError(403, 'ORIGIN_NOT_ALLOWED', 'Request origin is not allowed'));
      return;
    }
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Access-Control-Expose-Headers', 'X-Request-Id,Idempotency-Replayed,Retry-After');
    if (req.method !== 'OPTIONS') {
      next();
      return;
    }
    const method = req.get('access-control-request-method');
    const headers = (req.get('access-control-request-headers') ?? '')
      .toLowerCase()
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);
    if (
      !method ||
      !['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method) ||
      headers.some(
        (h) => !['authorization', 'content-type', 'idempotency-key', 'x-request-id'].includes(h),
      )
    ) {
      next(new AppError(403, 'CORS_PREFLIGHT_REJECTED', 'Unsupported CORS preflight'));
      return;
    }
    res.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE');
    res.set(
      'Access-Control-Allow-Headers',
      'Authorization,Content-Type,Idempotency-Key,X-Request-Id',
    );
    res.set('Access-Control-Max-Age', '600');
    res.status(204).end();
  };
}
