import { Router } from 'express';
import { createProfileController } from './profile.controller.js';
import type { ProfileServiceContract } from './profile.types.js';

export function createProfileRoutes(profileService: ProfileServiceContract) {
  const router = Router();
  const controller = createProfileController(profileService);

  router.get('/', controller.getProfile);
  router.patch('/', controller.patchProfile);

  return router;
}
