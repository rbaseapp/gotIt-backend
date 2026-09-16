import type { NextFunction, Request, Response } from 'express';
import type { CoreAuthClient } from '../core/core-auth.client.js';
import { AppError } from '../errors/app-error.js';

export function createAuthenticateMiddleware(coreAuthClient: CoreAuthClient) {
  return async function authenticate(request: Request, response: Response, next: NextFunction) {
    response.set('Cache-Control', 'no-store');
    try {
      const authorization = request.header('authorization');

      if (!authorization) {
        throw new AppError(401, 'UNAUTHORIZED', 'Authorization header is required');
      }

      const match = /^Bearer\s+(.+)$/i.exec(authorization);
      const accessToken = match?.[1]?.trim();

      if (!accessToken) {
        throw new AppError(401, 'UNAUTHORIZED', 'Bearer access token is required');
      }

      const identity = await coreAuthClient.validateAccessToken(accessToken, String(request.id));

      request.gotitAuth = identity;
      next();
    } catch (error) {
      next(error);
    }
  };
}
