import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../errors/app-error.js';

export type ApplicationRole = 'user' | 'admin';

export function createRequireRoleMiddleware(...allowedRoles: ApplicationRole[]) {
  const allowed = new Set(allowedRoles);

  return function requireRole(request: Request, _response: Response, next: NextFunction) {
    if (!request.gotitAuth) {
      next(new AppError(401, 'UNAUTHORIZED', 'Authentication is required'));
      return;
    }
    if (!allowed.has(request.gotitAuth.role)) {
      next(new AppError(403, 'FORBIDDEN', 'You do not have permission to perform this action'));
      return;
    }
    next();
  };
}

export const requireAdmin = createRequireRoleMiddleware('admin');
