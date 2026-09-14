import type { Logger } from 'pino';
import type { ProfileServiceContract } from '../../modules/profile/profile.types.js';
import type { CoreAuthClient } from '../core/core-auth.client.js';

export type AppDependencies = {
  logger: Logger;
  checkDatabase: () => Promise<void>;
  coreAuthClient: CoreAuthClient;
  profileService: ProfileServiceContract;
};
