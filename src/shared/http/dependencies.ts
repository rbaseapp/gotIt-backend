import type { Logger } from 'pino';
import type { CaptureService } from '../../modules/capture/capture.service.js';
import type { LibraryRepository } from '../../modules/library/library.repository.js';
import type { PracticeService } from '../../modules/practice/practice.service.js';
import type { DashboardService } from '../../modules/dashboard/dashboard.service.js';
import type { Pool } from 'pg';
import type { ReadingService } from '../../modules/reading/reading.service.js';
import type { SpeechService } from '../../modules/speech/speech.service.js';
import type { RateLimitContract } from '../middleware/rate-limit.js';
import type { ProfileServiceContract } from '../../modules/profile/profile.types.js';
import type { CoreAuthClient } from '../core/core-auth.client.js';

export type AppDependencies = {
  logger: Logger;
  checkDatabase: () => Promise<void>;
  coreAuthClient: CoreAuthClient;
  profileService: ProfileServiceContract;
  captureService?: CaptureService;
  libraryService?: LibraryRepository;
  practiceService?: PracticeService;
  dashboardService?: DashboardService;
  transferPool?: Pool;
  readingService?: ReadingService;
  speechService?: SpeechService;
  corsOrigins?: string[];
  trustProxyHops?: number;
  rateLimiter?: RateLimitContract;
};
