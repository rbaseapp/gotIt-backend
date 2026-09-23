import type { Logger } from 'pino';
import type { CoreBillingStatus } from '../core/core-auth.client.js';

export {};

declare global {
  namespace Express {
    interface Request {
      id: string;
      log?: Logger;
      gotitAuth?: {
        applicationId: string;
        applicationUserId: string;
      };
      gotitCoreAccessToken?: string;
      gotitBillingStatus?: CoreBillingStatus;
    }
  }
}
