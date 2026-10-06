import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { AppError } from '../../src/shared/errors/app-error.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { PROFILE_DEFAULTS } from '../../src/modules/profile/profile.constants.js';
import { PostgresPrivateLessonJournal } from '../../src/modules/private-lessons/private-lesson.repository.js';
import {
  LessonActivityService,
  PostgresLessonActivityStore,
  type LessonActivityCommand,
} from '../../src/modules/private-lessons/private-lesson.activity.js';
import { basicPrivateLessonReport } from '../../src/modules/private-lessons/private-lesson.summary.js';
import { guidedLessonPlan } from '../helpers/private-lesson-fixtures.js';
import { createTestDatabase } from '../helpers/postgres.js';

test(
  'guided lessons persist owner-scoped CAS and retry receipts, then remove transcripts atomically with the report',
  { timeout: 150_000 },
  async () => {
    const db = await createTestDatabase();
    try {
      const scope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
      await db.adminPool.query(
        "INSERT INTO core.applications(id,key,name) VALUES($1,'gotit','GotIt')",
        [scope.applicationId],
      );
      await db.adminPool.query(
        "INSERT INTO core.application_users(id,application_id,email) VALUES($1,$2,'guided@example.test')",
        [scope.applicationUserId, scope.applicationId],
      );
      await new ProfileRepository(db.runtimePool).ensureAndGet(scope, PROFILE_DEFAULTS);
      const journal = new PostgresPrivateLessonJournal(db.runtimePool);
      const store = new PostgresLessonActivityStore(db.runtimePool);
      const activities = new LessonActivityService(store, {
        generate: async (_scope, schema) =>
          schema.parse({
            understood: true,
            feedback: 'أحسنت في هذا الموقف.',
            followupQuestion: 'كيف تطلب الشاي الآن؟',
          }),
      });
      const plan = { ...guidedLessonPlan, id: randomUUID() };
      await journal.create(scope, plan);
      const initial = (await activities.create(scope, plan))!;
      assert.equal(initial.stage, 'learn');
      assert.equal((await store.get(scope, plan.id))?.snapshot.tutorText, initial.tutorText);
      assert.equal(await store.get({ ...scope, applicationUserId: randomUUID() }, plan.id), null);
      assert.equal(await store.get({ ...scope, applicationId: randomUUID() }, plan.id), null);
      const first: LessonActivityCommand = {
        eventId: randomUUID(),
        revision: 0,
        action: 'answer',
        answer: '水をください。',
      };
      const answer = await activities.act(scope, plan.id, first);
      assert.equal(answer.snapshot.stage, 'try');
      const second: LessonActivityCommand = { eventId: randomUUID(), revision: 1, action: 'hint' };
      const next = await activities.act(scope, plan.id, second);
      assert.equal(next.snapshot.hintUsed, true);
      assert.deepEqual((await activities.act(scope, plan.id, first)).snapshot, answer.snapshot);
      await assert.rejects(
        activities.act(scope, plan.id, { ...first, answer: 'forged changed text' }),
        (error) => error instanceof AppError && error.statusCode === 409,
      );
      const before = next.snapshot;
      const candidates = await Promise.allSettled(
        [1, 2].map(() =>
          store.save(
            scope,
            plan.id,
            { eventId: randomUUID(), revision: 2, action: 'continue' },
            { ...before, revision: 3, stage: 'chat' },
          ),
        ),
      );
      assert.equal(candidates.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(candidates.filter((result) => result.status === 'rejected').length, 1);
      await db.runtimePool.query(
        "UPDATE product_gotit.private_lesson_sessions SET started_at=clock_timestamp()-interval '1 hour' WHERE id=$1",
        [plan.id],
      );
      assert.equal((await store.get(scope, plan.id))?.active, false);
      await assert.rejects(
        store.save(
          scope,
          plan.id,
          { eventId: randomUUID(), revision: 3, action: 'hint' },
          { ...before, revision: 4 },
        ),
        (error) => error instanceof AppError && error.statusCode === 409,
      );
      await db.runtimePool.query(
        'UPDATE product_gotit.private_lesson_sessions SET started_at=clock_timestamp() WHERE id=$1',
        [plan.id],
      );
      await db.runtimePool.query(
        "UPDATE product_gotit.private_lesson_sessions SET status='summarizing' WHERE id=$1",
        [plan.id],
      );
      await assert.rejects(
        store.save(
          scope,
          plan.id,
          { eventId: randomUUID(), revision: 3, action: 'hint' },
          { ...before, revision: 4 },
        ),
        (error) => error instanceof AppError && error.statusCode === 409,
      );
      await journal.complete(scope, plan.id, basicPrivateLessonReport(plan));
      assert.equal((await journal.get(scope, plan.id))?.status, 'completed');
      const otherPlan = { ...guidedLessonPlan, id: randomUUID(), targetLanguageCode: 'fr' };
      await journal.create(scope, otherPlan);
      await journal.complete(scope, otherPlan.id, basicPrivateLessonReport(otherPlan));
      assert.deepEqual(
        (await journal.list(scope, 1, undefined, undefined, plan.targetLanguageCode)).map(
          (value) => value.id,
        ),
        [plan.id],
      );
      assert.deepEqual(
        (await journal.list(scope, 1, undefined, undefined, 'fr-CA')).map((value) => value.id),
        [otherPlan.id],
      );
      assert.deepEqual(
        await journal.list(
          { ...scope, applicationUserId: randomUUID() },
          50,
          undefined,
          undefined,
          'fr',
        ),
        [],
      );
      assert.equal(await store.get(scope, plan.id), null);
      assert.equal(
        (
          await db.runtimePool.query(
            'SELECT count(*) FROM product_gotit.private_lesson_activity_commands WHERE lesson_id=$1',
            [plan.id],
          )
        ).rows[0].count,
        '0',
      );
      await assert.rejects(
        db.runtimePool.query('CREATE TABLE product_gotit.runtime_ddl_forbidden (id integer)'),
      );
      await db.migrate('down');
      assert.equal(
        (
          await db.adminPool.query(
            "SELECT to_regclass('product_gotit.private_lesson_activities') AS relation",
          )
        ).rows[0].relation,
        null,
      );
      await db.migrate();
      assert.ok(
        (
          await db.runtimePool.query(
            "SELECT to_regclass('product_gotit.private_lesson_activities') AS relation",
          )
        ).rows[0].relation,
      );
    } finally {
      await db.dispose();
    }
  },
);
