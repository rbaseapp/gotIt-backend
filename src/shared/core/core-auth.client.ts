import { z } from 'zod';
import { AppError } from '../errors/app-error.js';

const coreMeResponseSchema = z
  .object({
    user: z
      .object({
        id: z.string().uuid(),
        applicationId: z.string().uuid(),
        email: z.string().email().optional(),
        emailVerified: z.boolean().optional(),
        status: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const billingStatusSchema = z.object({
  tier: z.enum(['free', 'paid']),
  access: z.boolean(),
  plan: z.object({ key: z.string(), name: z.string(), kind: z.enum(['free', 'paid']) }),
  entitlements: z.array(z.string()),
  subscription: z.object({
    status: z.enum(['trialing', 'active', 'past_due', 'paused', 'canceled']),
    cancelAtPeriodEnd: z.boolean(),
    currentPeriodEndsAt: z.string().datetime({ offset: true }).nullable(),
  }).nullable(),
});

export type CoreBillingStatus = z.infer<typeof billingStatusSchema>;

export type CoreAuthenticatedIdentity = {
  applicationId: string;
  applicationUserId: string;
};

type FetchLike = typeof fetch;

export class CoreAuthClient {
  constructor(
    private readonly options: {
      baseUrl: string;
      applicationKey: string;
      timeoutMs: number;
      fetchImpl?: FetchLike;
    },
  ) {}

  async validateAccessToken(
    accessToken: string,
    requestId?: string,
  ): Promise<CoreAuthenticatedIdentity> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = new URL('/api/v1/auth/me', this.options.baseUrl);

    let response: Response;

    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'x-application-key': this.options.applicationKey,
          ...(requestId ? { 'x-request-id': requestId } : {}),
        },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new AppError(
        503,
        'CORE_AUTH_UNAVAILABLE',
        'Authentication service is unavailable',
        error instanceof Error ? { cause: error.name } : undefined,
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired access token');
    }

    if (!response.ok) {
      throw new AppError(503, 'CORE_AUTH_UNAVAILABLE', 'Authentication service is unavailable');
    }

    let payload: unknown;

    try {
      payload = await response.json();
    } catch {
      throw new AppError(
        503,
        'CORE_AUTH_INVALID_RESPONSE',
        'Authentication service returned an invalid response',
      );
    }

    const parsed = coreMeResponseSchema.safeParse(payload);

    if (!parsed.success) {
      throw new AppError(
        503,
        'CORE_AUTH_INVALID_RESPONSE',
        'Authentication service returned an invalid response',
      );
    }

    return {
      applicationId: parsed.data.user.applicationId,
      applicationUserId: parsed.data.user.id,
    };
  }

  async getBillingStatus(accessToken: string, requestId?: string): Promise<CoreBillingStatus> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const url = new URL('/api/v1/billing/status', this.options.baseUrl);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'x-application-key': this.options.applicationKey,
          ...(requestId ? { 'x-request-id': requestId } : {}),
        },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new AppError(503, 'CORE_BILLING_UNAVAILABLE', 'Billing service is unavailable',
        error instanceof Error ? { cause: error.name } : undefined);
    }
    if (response.status === 401 || response.status === 403)
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired access token');
    if (!response.ok) throw new AppError(503, 'CORE_BILLING_UNAVAILABLE', 'Billing service is unavailable');
    const parsed = billingStatusSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new AppError(503, 'CORE_BILLING_INVALID_RESPONSE', 'Billing service returned an invalid response');
    return parsed.data;
  }
}
