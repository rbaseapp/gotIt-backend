import type { Logger } from 'pino';

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
    }
  }
}
