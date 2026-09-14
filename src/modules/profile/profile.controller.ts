import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../shared/errors/app-error.js';
import type { ProfileServiceContract } from './profile.types.js';
import { profilePatchSchema } from './profile.validation.js';

export function createProfileController(profileService: ProfileServiceContract) {
  return {
    getProfile: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const identity = getIdentity(request);
        const profile = await profileService.getProfile(identity);

        response.status(200).json({
          profile,
          requestId: request.id,
        });
      } catch (error) {
        next(error);
      }
    },

    patchProfile: async (request: Request, response: Response, next: NextFunction) => {
      try {
        const identity = getIdentity(request);
        const parsed = profilePatchSchema.safeParse(request.body);

        if (!parsed.success) {
          throw new AppError(
            400,
            'VALIDATION_ERROR',
            'Request validation failed',
            parsed.error.flatten(),
          );
        }

        const profile = await profileService.patchProfile(identity, parsed.data);

        response.status(200).json({
          profile,
          requestId: request.id,
        });
      } catch (error) {
        next(error);
      }
    },
  };
}

function getIdentity(request: Request) {
  if (!request.gotitAuth) {
    throw new AppError(500, 'AUTH_CONTEXT_MISSING', 'Authenticated context is missing');
  }

  return request.gotitAuth;
}
