import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTestDatabase } from '../helpers/postgres.js';
import { adaptiveLesson, adaptiveCurriculum } from '../helpers/adaptive-lesson-fixtures.js';
import { PROFILE_DEFAULTS } from '../../src/modules/profile/profile.constants.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { PostgresPrivateLessonJournal } from '../../src/modules/private-lessons/private-lesson.repository.js';
import { basicPrivateLessonReport } from '../../src/modules/private-lessons/private-lesson.summary.js';
import {
  PostgresLessonActivityStore,
  initialActivity,
  advanceActivity,
  type LessonActivityCommand,
} from '../../src/modules/private-lessons/private-lesson.activity.js';
import { buildRealtimeLessonContract } from '../../src/modules/private-lessons/private-lesson.realtime.js';

test(
  'adaptive activity ownership, replay, concurrent commits, expiry, final evidence and migration are real PostgreSQL boundaries',
  { timeout: 180000 },
  async (t) => {
    const db = await createTestDatabase();
    try {
      const scope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
      await db.adminPool.query(
        "INSERT INTO core.applications(id,key,name) VALUES($1,'adaptive-test','Adaptive test')",
        [scope.applicationId],
      );
      await db.adminPool.query(
        "INSERT INTO core.application_users(id,application_id,email) VALUES($1,$2,'adaptive@example.test')",
        [scope.applicationUserId, scope.applicationId],
      );
      await new ProfileRepository(db.runtimePool).ensureAndGet(scope, PROFILE_DEFAULTS);
      const journal = new PostgresPrivateLessonJournal(db.runtimePool),
        store = new PostgresLessonActivityStore(db.runtimePool);
      const lesson = adaptiveLesson(),
        curriculum = adaptiveCurriculum(lesson);
      lesson.realtimeContract = buildRealtimeLessonContract(lesson, {
        model: 'test-realtime',
        transcriptionModel: 'test-transcription',
      });
      await journal.create(scope, lesson);
      await store.create(scope, lesson, curriculum, initialActivity(lesson, curriculum, 'guided'));
      let record = (await store.get(scope, lesson.id))!;
      const cmd = (): LessonActivityCommand => ({
        eventId: randomUUID(),
        revision: record.state.view.revision,
        activityId: record.state.view.activityId,
        action: 'answer',
        answer: 'Where is the station?',
        channel: 'text',
      });
      const result = {
        result: 'independent' as const,
        feedback: 'Meaning confirmed.',
        retryQuestion: 'Ask about the next situation.',
        evidenceQuote: 'Where is the station?',
      };

      await t.test(
        'foreign user and application cannot read or mutate another lesson',
        async () => {
          for (const foreign of [
            { ...scope, applicationUserId: randomUUID() },
            { ...scope, applicationId: randomUUID() },
          ]) {
            assert.equal(await store.get(foreign, lesson.id), null);
            const command = cmd();
            assert.equal(await store.replay(foreign, lesson.id, command), null);
            await assert.rejects(
              store.save(foreign, lesson.id, command, advanceActivity(record, command, result)),
              { code: 'PRIVATE_LESSON_ACTIVITY_CONFLICT' },
            );
          }
        },
      );
      await t.test(
        'same UUID replays one committed state and changed payload conflicts',
        async () => {
          const command = cmd(),
            next = advanceActivity(record, command, result);
          const results = await Promise.all([
            store.save(scope, lesson.id, command, next),
            store.save(scope, lesson.id, command, next),
          ]);
          assert.deepEqual(results[0], results[1]);
          assert.deepEqual(await store.replay(scope, lesson.id, command), next);
          await assert.rejects(
            store.replay(scope, lesson.id, { ...command, answer: 'different payload' }),
            { code: 'PRIVATE_LESSON_ACTIVITY_CONFLICT' },
          );
          assert.equal(
            (
              await db.runtimePool.query(
                'SELECT count(*)::int AS n FROM product_gotit.private_lesson_activity_commands WHERE lesson_id=$1',
                [lesson.id],
              )
            ).rows[0].n,
            1,
          );
          record = (await store.get(scope, lesson.id))!;
        },
      );
      await t.test('different concurrent commands cannot both advance a revision', async () => {
        const a = cmd(),
          b = cmd();
        const outcomes = await Promise.allSettled([
          store.save(scope, lesson.id, a, advanceActivity(record, a, result)),
          store.save(scope, lesson.id, b, advanceActivity(record, b, result)),
        ]);
        assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
        assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
        record = (await store.get(scope, lesson.id))!;
      });
      await t.test(
        'translation assistance is idempotent and cannot become independent evidence',
        async () => {
          const revision = record.state.view.revision;
          await store.markAssisted(scope, lesson.id, record.state.view.activityId, revision);
          await store.markAssisted(scope, lesson.id, record.state.view.activityId, revision);
          record = (await store.get(scope, lesson.id))!;
          assert.equal(record.state.view.revision, revision);
          assert.equal(record.state.view.hintUsed, true);
          const command = cmd(),
            next = advanceActivity(record, command, result);
          assert.equal(next.outcomes.at(-1)?.outcome, 'assisted');
          await store.save(scope, lesson.id, command, next);
          record = (await store.get(scope, lesson.id))!;
        },
      );
      await t.test('a deadline reached during provider work rejects the final commit', async () => {
        const command = cmd(),
          next = advanceActivity(record, command, result);
        await db.adminPool.query(
          "UPDATE product_gotit.private_lesson_sessions SET started_at=now()-interval '1 hour' WHERE id=$1",
          [lesson.id],
        );
        await assert.rejects(store.save(scope, lesson.id, command, next), {
          code: 'PRIVATE_LESSON_ACTIVITY_CONFLICT',
        });
        assert.equal(
          (await store.get(scope, lesson.id))?.state.view.revision,
          record.state.view.revision,
        );
        await db.adminPool.query(
          'UPDATE product_gotit.private_lesson_sessions SET started_at=now() WHERE id=$1',
          [lesson.id],
        );
      });
      await t.test('revision budget exceeds the historical 100-command limit', async () => {
        await db.adminPool.query(
          "UPDATE product_gotit.private_lesson_activities SET revision=101,snapshot=jsonb_set(snapshot,'{view,revision}','101') WHERE lesson_id=$1",
          [lesson.id],
        );
        assert.equal((await store.get(scope, lesson.id))?.state.view.revision, 101);
      });
      await t.test(
        'claiming a report stops activity writes; failed report keeps temporary evidence',
        async () => {
          record = (await store.get(scope, lesson.id))!;
          const command = cmd(),
            next = advanceActivity(record, command, result);
          const claimed = await journal.claim(scope, lesson.id, 50);
          assert.equal(claimed?.interactionProtocol, 'adaptive-v1');
          await assert.rejects(store.save(scope, lesson.id, command, next), {
            code: 'PRIVATE_LESSON_ACTIVITY_CONFLICT',
          });
          await journal.fail(scope, lesson.id, 'generation_failed');
          assert.ok(await store.get(scope, lesson.id));
          await journal.claim(scope, lesson.id, 50);
          await journal.complete(scope, lesson.id, basicPrivateLessonReport(lesson));
          assert.equal(await store.get(scope, lesson.id), null);
          assert.equal(
            (
              await db.runtimePool.query(
                'SELECT count(*)::int AS n FROM product_gotit.private_lesson_activity_commands WHERE lesson_id=$1',
                [lesson.id],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        'soft deletion and retention cleanup purge activity text and receipts',
        async () => {
          for (const reason of ['delete', 'expiry']) {
            const another = adaptiveLesson();
            await journal.create(scope, another);
            await store.create(
              scope,
              another,
              curriculum,
              initialActivity(another, curriculum, 'guided'),
            );
            if (reason === 'delete') await journal.remove(scope, another.id);
            else {
              await db.adminPool.query(
                "UPDATE product_gotit.private_lesson_sessions SET started_at=now()-interval '9 days' WHERE id=$1",
                [another.id],
              );
              await store.purgeExpired();
            }
            assert.equal(await store.get(scope, another.id), null);
          }
        },
      );
      await t.test(
        'the forward migration can be reversed on a disposable compatible database',
        async () => {
          await db.rollbackAfter('1792640000000_adaptive-lesson-activity-budget');
          await db.migrate('down');
          await db.migrate('up');
        },
      );
    } finally {
      await db.dispose();
    }
  },
);
