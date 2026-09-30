import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { AddonAccessContract, AddonKind } from '../../modules/addons/addon-access.js';
import { addonRequired } from '../../modules/addons/addon-access.js';

export function createRequireAddonMiddleware(
  access: AddonAccessContract,
  kind: AddonKind,
): RequestHandler {
  return async (request, _response, next) => {
    try {
      if (request.gotitAuth?.role !== 'admin' && !(await access.status(request.gotitAuth!, kind)))
        throw addonRequired(kind);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireBoth(first: RequestHandler, second: RequestHandler): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) =>
    first(request, response, (error?: unknown) => {
      if (error) next(error);
      else second(request, response, next);
    });
}
