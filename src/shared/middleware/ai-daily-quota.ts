import { AppError } from '../errors/app-error.js';
import type { ProfileScope } from '../../modules/profile/profile.types.js';
import type { RateLimitContract } from './rate-limit.js';

export type AiDailyFeature =
  | 'course_generation'
  | 'course_transcription'
  | 'private_lesson_brief'
  | 'private_lesson_report'
  | 'ai_translation'
  | 'study_image_brief'
  | 'study_image_generation';

const LIMITS: Record<AiDailyFeature, number> = {
  course_generation: 40,
  course_transcription: 40,
  private_lesson_brief: 60,
  private_lesson_report: 60,
  ai_translation: 100,
  study_image_brief: 60,
  study_image_generation: 20,
};

export class AiDailyQuota {
  constructor(private readonly limiter: RateLimitContract) {}

  async consume(scope: ProfileScope, feature: AiDailyFeature) {
    const result = await this.limiter.consume(
      `gotit:ai-daily:${scope.applicationId}:${scope.applicationUserId}:${feature}`,
      LIMITS[feature],
      86_400,
    );
    if (!result.allowed)
      throw new AppError(429, 'AI_DAILY_LIMIT_REACHED', 'The daily AI usage limit was reached', {
        feature,
        retryAfter: result.retryAfter,
      });
  }
}
