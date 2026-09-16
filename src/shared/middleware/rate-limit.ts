import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { RequestHandler } from 'express';
import { AppError } from '../errors/app-error.js';
export type RateLimitContract = {
  consume: (
    key: string,
    limit: number,
    seconds: number,
  ) => Promise<{ allowed: boolean; retryAfter: number }>;
};
export class PostgresRateLimiter implements RateLimitContract {
  constructor(private readonly pool: Pool) {}
  async consume(key: string, limit: number, seconds: number) {
    try {
      const result = await this.pool.query<{ request_count: number; retry_after: number }>(
        `WITH clock AS(SELECT clock_timestamp() AS request_time),bucket AS(SELECT to_timestamp(floor(extract(epoch FROM request_time)/$3)*$3) AS window_begin FROM clock)
        INSERT INTO product_gotit.api_rate_limits(bucket_key,window_start,request_count,expires_at) SELECT $1,window_begin,1,window_begin+make_interval(secs=>$3::integer) FROM bucket
        ON CONFLICT(bucket_key) DO UPDATE SET window_start=EXCLUDED.window_start,request_count=CASE WHEN product_gotit.api_rate_limits.window_start=EXCLUDED.window_start THEN LEAST(product_gotit.api_rate_limits.request_count+1,$2+1) ELSE 1 END,expires_at=EXCLUDED.expires_at
        RETURNING request_count,GREATEST(1,ceil(extract(epoch FROM expires_at-clock_timestamp())))::integer AS retry_after`,
        [createHash('sha256').update(key).digest('hex'), limit, seconds],
      );
      const row = result.rows[0]!;
      return { allowed: row.request_count <= limit, retryAfter: row.retry_after };
    } catch {
      throw new AppError(
        503,
        'RATE_LIMIT_UNAVAILABLE',
        'Request limiter is temporarily unavailable',
      );
    }
  }
  async cleanup() {
    await this.pool.query(
      'DELETE FROM product_gotit.api_rate_limits WHERE bucket_key IN(SELECT bucket_key FROM product_gotit.api_rate_limits WHERE expires_at<clock_timestamp() LIMIT 1000)',
    );
  }
}
export function createRateLimit(
  limiter: RateLimitContract,
  kind: 'ip' | 'user',
  limit: number,
  seconds = 60,
): RequestHandler {
  return async (req, res, next) => {
    try {
      const scope = req.gotitAuth;
      const expensive =
        /^\/api\/v1\/(?:captures\/preview|reading\/preview|pronunciation\/assessments|learning-items\/[^/]+\/audio|import)$/u.test(
          req.originalUrl.split('?')[0]!,
        );
      const identity =
        kind === 'ip'
          ? (req.ip ?? req.socket.remoteAddress ?? 'unknown')
          : `${scope?.applicationId}:${scope?.applicationUserId}`;
      if (kind === 'user' && !scope)
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication is required');
      const bucket = `gotit:${kind}:${identity}:${expensive ? 'provider' : 'api'}`;
      const result = await limiter.consume(
        bucket,
        expensive ? Math.min(limit, 20) : limit,
        seconds,
      );
      if (!result.allowed) {
        res.set('Retry-After', String(result.retryAfter));
        throw new AppError(429, 'RATE_LIMITED', 'Too many requests');
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
