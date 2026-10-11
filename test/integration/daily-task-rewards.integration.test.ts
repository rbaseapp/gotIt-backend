import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTestDatabase } from '../helpers/postgres.js';
import { guidedLessonPlan } from '../helpers/private-lesson-fixtures.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import { PROFILE_DEFAULTS } from '../../src/modules/profile/profile.constants.js';
import { PostgresPrivateLessonJournal } from '../../src/modules/private-lessons/private-lesson.repository.js';
import { basicPrivateLessonReport } from '../../src/modules/private-lessons/private-lesson.summary.js';
import { DashboardService } from '../../src/modules/dashboard/dashboard.service.js';
import { awardDailyTask, type DailyTask } from '../../src/modules/dashboard/daily-task-rewards.js';
import { withTransaction } from '../../src/shared/database/transaction.js';
import type { ProfileScope } from '../../src/modules/profile/profile.types.js';

test(
  'daily task bonuses are atomic, scoped, calendar-based and independent of practice caps',
  { timeout: 150000 },
  async () => {
    const db = await createTestDatabase();
    try {
      const scopes = Array.from({ length: 3 }, () => ({
        applicationId: randomUUID(),
        applicationUserId: randomUUID(),
      }));
      const profiles = new ProfileService(new ProfileRepository(db.runtimePool));
      for (const scope of scopes) {
        await db.adminPool.query(
          "INSERT INTO core.applications(id,key,name) VALUES($1,$2,'GotIt')",
          [scope.applicationId, randomUUID()],
        );
        await db.adminPool.query(
          "INSERT INTO core.application_users(id,application_id,email) VALUES($1,$2,'bonus@example.test')",
          [scope.applicationUserId, scope.applicationId],
        );
        await new ProfileRepository(db.runtimePool).ensureAndGet(scope, {
          ...PROFILE_DEFAULTS,
          timezone: 'Asia/Jerusalem',
        });
      }
      const [learner, other, calendar] = scopes as [ProfileScope, ProfileScope, ProfileScope];
      const grant = (scope: ProfileScope, task: DailyTask, now = new Date()) =>
        withTransaction(db.runtimePool, async (tx) => {
          await tx.lock(['practice-user', scope.applicationId, scope.applicationUserId]);
          return awardDailyTask(tx, scope, task, randomUUID(), 'Asia/Jerusalem', now);
        });
      const concurrent = await Promise.all(Array.from({ length: 8 }, () => grant(other, 'lesson')));
      assert.equal(
        concurrent.reduce<number>((a, b) => a + b, 0),
        100,
      );
      assert.equal(await grant(other, 'conversation'), 75);
      assert.equal(await grant(other, 'reading'), 50);
      const dashboard = new DashboardService(db.runtimePool, profiles);
      const otherXp = await dashboard.gamification(other);
      assert.equal(otherXp.todayXp, 225);
      assert.equal(otherXp.totalXp, 225);
      assert.equal(
        otherXp.dailyXpRemaining,
        200,
        'task bonuses do not use the ordinary practice cap',
      );
      assert.equal(
        (await dashboard.gamification(learner)).totalXp,
        0,
        'no cross-application or user awards',
      );

      await assert.rejects(
        withTransaction(db.runtimePool, async (tx) => {
          await tx.lock(['practice-user', learner.applicationId, learner.applicationUserId]);
          await awardDailyTask(tx, learner, 'reading', randomUUID(), 'Asia/Jerusalem', new Date());
          throw new Error('rollback test');
        }),
      );
      assert.equal((await dashboard.gamification(learner)).totalXp, 0);
      assert.equal(await grant(learner, 'reading'), 50, 'rollback leaves the award available');

      assert.equal(await grant(calendar, 'lesson', new Date('2030-01-01T21:59:00Z')), 100);
      assert.equal(
        await grant(calendar, 'lesson', new Date('2030-01-01T22:01:00Z')),
        100,
        'Jerusalem midnight resets the daily bonus',
      );
      assert.equal(await grant(calendar, 'lesson', new Date('2030-01-02T15:00:00Z')), 0);

      const journal = new PostgresPrivateLessonJournal(db.runtimePool);
      const finish = async (structured: boolean, meaningful: boolean) => {
        const plan = { ...guidedLessonPlan, id: randomUUID() };
        await journal.create(learner, plan);
        if (structured)
          await db.runtimePool.query(
            'UPDATE product_gotit.private_lesson_sessions SET course_context=$4::jsonb WHERE application_id=$1 AND application_user_id=$2 AND id=$3',
            [
              learner.applicationId,
              learner.applicationUserId,
              plan.id,
              JSON.stringify({ courseId: randomUUID() }),
            ],
          );
        await journal.claim(learner, plan.id, 300);
        const report = basicPrivateLessonReport(plan);
        if (meaningful) report.assessment.lessonPerformance.evidenceQuality = 'weak';
        await journal.complete(learner, plan.id, report);
        return { plan, report };
      };
      await finish(false, false);
      assert.equal(
        (await dashboard.gamification(learner)).totalXp,
        50,
        'an empty or insufficient report earns no lesson reward',
      );
      const conversation = await finish(false, true);
      await journal.complete(learner, conversation.plan.id, conversation.report);
      await finish(false, true);
      assert.equal(
        (await dashboard.gamification(learner)).totalXp,
        125,
        'conversation reward is once daily, including retries and different calls',
      );
      await finish(true, true);
      const completed = await dashboard.gamification(learner);
      assert.equal(completed.totalXp, 225);
      assert.deepEqual(completed.dailyTaskRewards, {
        lesson: { xp: 100, completed: true },
        conversation: { xp: 75, completed: true },
        reading: { xp: 50, completed: true },
      });
    } finally {
      await db.dispose();
    }
  },
);
