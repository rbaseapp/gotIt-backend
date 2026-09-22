import type { NextFunction, Request, Response } from 'express';
import type { CoreAuthClient } from '../core/core-auth.client.js';
import { AppError } from '../errors/app-error.js';

export function createRequireEntitlementMiddleware(
  core: CoreAuthClient,
  entitlement: string,
  enabled = true,
) {
  return async function requireEntitlement(
    request: Request,
    _response: Response,
    next: NextFunction,
  ) {
    if (!enabled) {
      next();
      return;
    }
    try {
      if (!request.gotitCoreAccessToken)
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication is required');
      const billing = await core.getBillingStatus(request.gotitCoreAccessToken, String(request.id));
      if (!billing.access || !billing.entitlements.includes(entitlement)) {
        throw new AppError(
          402,
          'SUBSCRIPTION_REQUIRED',
          'This feature requires a paid subscription',
          {
            entitlement,
            currentPlan: billing.plan.key,
          },
        );
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
