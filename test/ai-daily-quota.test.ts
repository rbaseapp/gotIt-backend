import assert from 'node:assert/strict';
import test from 'node:test';
import { AiDailyQuota } from '../src/shared/middleware/ai-daily-quota.js';

test('authenticated administrators have no daily AI plan quota', async () => {
  const quota = new AiDailyQuota({
    consume: async () => {
      throw new Error('Admin must not consume a finite allowance');
    },
  });
  for (const feature of [
    'ai_translation',
    'course_generation',
    'study_image_generation',
    'private_lesson_report',
  ] as const)
    for (let i = 0; i < 105; i++)
      await quota.consume(
        { applicationId: 'app', applicationUserId: 'admin', role: 'admin' },
        feature,
      );
});

test('daily AI quotas are scoped to user and feature and reject only the exhausted feature', async () => {
  const counts = new Map<string, number>();
  const quota = new AiDailyQuota({
    async consume(key, limit, seconds) {
      assert.equal(seconds, 86_400);
      const used = (counts.get(key) ?? 0) + 1;
      counts.set(key, used);
      return { allowed: used <= limit, retryAfter: 120 };
    },
  });
  const user = { applicationId: 'app', applicationUserId: 'user-one' };
  for (let index = 0; index < 20; index++) await quota.consume(user, 'study_image_generation');
  await assert.rejects(
    quota.consume(user, 'study_image_generation'),
    (error: any) => error.code === 'AI_DAILY_LIMIT_REACHED' && error.statusCode === 429,
  );
  await quota.consume(user, 'course_generation');
  await quota.consume({ ...user, applicationUserId: 'user-two' }, 'study_image_generation');
  for (let index = 0; index < 200; index++)
    await quota.consume(user, 'concept_assignment_backfill');
  await assert.rejects(quota.consume(user, 'concept_assignment_backfill'));
  await quota.consume(user, 'concept_assignment_live');
  await quota.consume(user, 'ai_translation');
});
