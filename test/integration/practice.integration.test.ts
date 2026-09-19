import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import request from 'supertest';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { sessionSchema, exercisesSchema } from '../../src/modules/practice/practice.validation.js';
import { createApp } from '../../src/app.js';
import { CaptureRepository } from '../../src/modules/capture/capture.repository.js';
import { CaptureService } from '../../src/modules/capture/capture.service.js';
import { saveSchema } from '../../src/modules/capture/capture.validation.js';
import { EnrichmentRegistry } from '../../src/modules/enrichment/enrichment.registry.js';
import { SelectionProofs } from '../../src/modules/enrichment/selection-proof.js';
import { LibraryRepository } from '../../src/modules/library/library.repository.js';
import { PracticeService } from '../../src/modules/practice/practice.service.js';
import { policySchema } from '../../src/modules/learning/learning.policy.js';
import { DashboardService } from '../../src/modules/dashboard/dashboard.service.js';
import { ReadingService } from '../../src/modules/reading/reading.service.js';
import { SpeechService } from '../../src/modules/speech/speech.service.js';
import { readingInputSchema } from '../../src/modules/reading/reading.validation.js';
import { PostgresRateLimiter } from '../../src/shared/middleware/rate-limit.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import { CoreAuthClient } from '../../src/shared/core/core-auth.client.js';
import { createLogger } from '../../src/shared/logger/logger.js';
import { createTestDatabase } from '../helpers/postgres.js';

test(
  'library and issued practice exercise lifecycle on product-only PostgreSQL',
  { timeout: 150000 },
  async (t) => {
    const db = await createTestDatabase();
    try {
      const applicationId = randomUUID(),
        users = [randomUUID(), randomUUID()];
      await db.adminPool.query(
        "INSERT INTO core.applications(id,key,name) VALUES($1,'gotit','GotIt')",
        [applicationId],
      );
      for (const [i, id] of users.entries())
        await db.adminPool.query(
          'INSERT INTO core.application_users(id,application_id,email) VALUES($1,$2,$3)',
          [id, applicationId, `practice-${i}@example.test`],
        );
      const profiles = new ProfileService(new ProfileRepository(db.runtimePool));
      const practices = new PracticeService(db.runtimePool, profiles);
      let generationCalls = 0,
        readingClock = Date.now();
      const readings = new ReadingService(
        db.runtimePool,
        profiles,
        practices,
        {
          id: 'test_generator',
          generate: async (input) => {
            generationCalls++;
            return {
              title: 'A useful story',
              bodyText: `This is a reading passage with these expressions: ${input.targets.map((t) => t.sourceText).join(', ')}. Use them in a natural conversation.`,
              providerModel: 'test_model',
            };
          },
        },
        'r'.repeat(32),
        () => readingClock,
      );
      const app = createApp({
        logger: createLogger('silent'),
        checkDatabase: async () => {},
        profileService: profiles,
        coreAuthClient: new CoreAuthClient({
          baseUrl: 'https://core.example.test',
          applicationKey: 'gotit',
          timeoutMs: 1000,
          fetchImpl: async (_url, init) => {
            const i = Number(new Headers(init?.headers).get('authorization')?.slice(-1));
            return users[i]
              ? Response.json({ user: { id: users[i], applicationId } })
              : new Response(null, { status: 401 });
          },
        }),
        captureService: new CaptureService(
          new CaptureRepository(db.runtimePool),
          profiles,
          new EnrichmentRegistry(),
          new SelectionProofs(undefined),
        ),
        libraryService: new LibraryRepository(db.runtimePool),
        practiceService: practices,
        dashboardService: new DashboardService(db.runtimePool, profiles),
        transferPool: db.runtimePool,
        readingService: readings,
        speechService: new SpeechService(db.runtimePool, practices),
      });
      const auth = (user = 0) => `Bearer user-${user}`;
      const call = (
        method: 'get' | 'post' | 'patch' | 'delete' | 'put',
        url: string,
        body?: object,
        key = randomUUID(),
        user = 0,
      ) =>
        request(app)
          [method](`/api/v1${url}`)
          .set('Authorization', auth(user))
          .set('Idempotency-Key', key)
          .send(body);
      const ids: string[] = [];
      for (const [source, text] of [
        ['hello', 'שלום'],
        ['world', 'עולם'],
        ['percent%_', 'אחוז'],
      ]) {
        const captured = await call('post', '/captures', {
          item: {
            sourceText: source,
            sourceLanguageCode: 'en',
            translationLanguageCode: 'he',
            itemType: 'word',
          },
          translation: { text },
          context: { selectedText: source },
          senseDecision: { mode: 'auto' },
        }).expect(201);
        ids.push(captured.body.capture.learningItemId);
      }
      let sessionId: string, exerciseId: string;
      await t.test(
        'library search and pagination preserve filters and scope; bulk operations roll back foreign IDs',
        async () => {
          const list = await call('get', '/learning-items?limit=1&sort=alphabetical').expect(200);
          assert.equal(list.body.items.length, 1);
          assert.ok(list.body.nextCursor);
          const next = await call(
            'get',
            `/learning-items?limit=1&sort=alphabetical&cursor=${list.body.nextCursor}`,
          ).expect(200);
          assert.notEqual(next.body.items[0].id, list.body.items[0].id);
          await call(
            'get',
            `/learning-items?limit=1&sort=recent&cursor=${list.body.nextCursor}`,
          ).expect(400);
          assert.equal(
            (await call('get', '/learning-items?search=%25_').expect(200)).body.items.length,
            1,
          );
          assert.equal(
            (await call('get', '/learning-items', undefined, randomUUID(), 1).expect(200)).body
              .items.length,
            0,
          );
          await call('post', '/learning-items/bulk', {
            ids: [ids[0], randomUUID()],
            action: 'pause',
          }).expect(404);
          assert.equal(
            (await call('get', `/learning-items/${ids[0]}`).expect(200)).body.learningItem
              .userStatus,
            'active',
          );
          const tag = await call('post', '/tags', { name: 'travel' }).expect(201);
          await call('put', `/learning-items/${ids[0]}/tags`, { tagIds: [tag.body.tag.id] }).expect(
            200,
          );
          assert.equal(
            (await call('get', `/learning-items?tagId=${tag.body.tag.id}`).expect(200)).body.items
              .length,
            1,
          );
          await call('put', `/learning-items/${ids[0]}/examples`, {
            examples: ['Hello, world.'],
          }).expect(200);
        },
      );
      await t.test(
        'issued exercises hide answers and owned challenge is required; client score and foreign session are rejected',
        async () => {
          const key = randomUUID(),
            input = { sessionType: 'recall', learningItemIds: ids };
          const session = await call('post', '/practice/sessions', input, key).expect(201);
          sessionId = session.body.session.id;
          assert.deepEqual(
            (await call('post', '/practice/sessions', input, key).expect(200)).body.session,
            session.body.session,
          );
          await call(
            'post',
            '/practice/sessions',
            { ...input, sessionType: 'flashcards' },
            key,
          ).expect(409);
          await call('get', `/practice/sessions/${sessionId}`, undefined, randomUUID(), 1).expect(
            404,
          );
          const issued = await call('post', `/practice/sessions/${sessionId}/exercises`, {
            count: 1,
          }).expect(201);
          const exercise = issued.body.exercises[0];
          exerciseId = exercise.id;
          assert.equal(exercise.prompt.answer, undefined);
          assert.equal(exercise.prompt.letterCount, 5);
          assert.equal(exercise.answerSpec, undefined);
          await call('post', '/practice/attempts', {
            exerciseId,
            answerText: 'hello',
            score: 100,
          }).expect(400);
          await call(
            'post',
            '/practice/attempts',
            { exerciseId, answerText: 'hello' },
            randomUUID(),
            1,
          ).expect(404);
        },
      );
      await t.test(
        'concurrent retries consume once and return original receipt; score and XP are server-derived',
        async () => {
          const exercise = (
            await db.adminPool.query(
              'SELECT learning_item_id FROM product_gotit.practice_exercises WHERE id=$1',
              [exerciseId],
            )
          ).rows[0];
          const item = (
            await db.adminPool.query(
              'SELECT source_text FROM product_gotit.learning_items WHERE id=$1',
              [exercise.learning_item_id],
            )
          ).rows[0];
          const input = { exerciseId, answerText: item.source_text },
            key = randomUUID();
          const results = await Promise.all([
            call('post', '/practice/attempts', input, key),
            call('post', '/practice/attempts', input, key),
          ]);
          assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
          assert.deepEqual(results[0].body.attempt, results[1].body.attempt);
          assert.equal(results[0].body.attempt.score, 100);
          assert.equal(results[0].body.attempt.xpEarned, 10);
          assert.equal(
            (
              await db.adminPool.query(
                'SELECT count(*)::integer count FROM product_gotit.practice_attempts',
              )
            ).rows[0].count,
            1,
          );
          await call('post', '/practice/attempts', input).expect(409);
          await call(
            'post',
            '/practice/attempts',
            { ...input, answerText: 'different' },
            key,
          ).expect(409);
          await call('patch', `/learning-items/${exercise.learning_item_id}`, {
            sourceText: 'edited source',
            translation: { text: 'confirmed edited meaning' },
          }).expect(200);
          const edited = (
            await call('get', `/learning-items/${exercise.learning_item_id}`).expect(200)
          ).body.learningItem;
          assert.equal(edited.learningRevision, 2);
          assert.ok(edited.skills.every((s: any) => s.attemptCount === 0));
          assert.equal(edited.translations.length, 1);
          assert.equal(edited.translations[0].text, 'confirmed edited meaning');
          assert.equal(
            (
              await db.adminPool.query(
                'SELECT count(*)::integer count FROM product_gotit.item_translations WHERE learning_item_id=$1 AND NOT is_current',
                [exercise.learning_item_id],
              )
            ).rows[0].count,
            1,
          );
          assert.deepEqual(
            (await call('post', '/practice/attempts', input, key).expect(200)).body.attempt,
            results[0].body.attempt,
          );
        },
      );
      await t.test(
        'new semantic revision excludes historical evidence while same-sense variants and manual mastery preserve attempts without rewards',
        async () => {
          const session = (
            await call('post', '/practice/sessions', {
              sessionType: 'recall',
              learningItemIds: [ids[0]],
            }).expect(201)
          ).body.session;
          const challenge = (
            await call('post', `/practice/sessions/${session.id}/exercises`, { count: 1 }).expect(
              201,
            )
          ).body.exercises[0];
          const attempt = await call('post', '/practice/attempts', {
            exerciseId: challenge.id,
            answerText: 'edited source',
          }).expect(201);
          assert.equal(attempt.body.attempt.xpEarned, 0);
          assert.equal(
            attempt.body.skills.find((s: any) => s.skillType === 'recall').attemptCount,
            1,
          );
          const variant = await call('patch', `/learning-items/${ids[0]}`, {
            translation: { text: 'confirmed edited meaning', variants: ['same-sense alternative'] },
          }).expect(200);
          assert.equal(variant.body.learningItem.progressReset, false);
          const ledger = (
            await db.adminPool.query('SELECT count(*)::integer count FROM product_gotit.xp_events')
          ).rows[0].count;
          await call('post', `/learning-items/${ids[0]}/mastery`, { mastered: true }).expect(200);
          const mastered = (await call('get', `/learning-items/${ids[0]}`).expect(200)).body
            .learningItem;
          assert.equal(mastered.masterySource, 'user');
          assert.equal(mastered.skills.find((s: any) => s.skillType === 'recall').attemptCount, 1);
          await call('post', `/learning-items/${ids[0]}/mastery`, { mastered: false }).expect(200);
          assert.equal(
            (
              await db.adminPool.query(
                'SELECT count(*)::integer count FROM product_gotit.xp_events',
              )
            ).rows[0].count,
            ledger,
          );
        },
      );
      await t.test(
        'skipping does not alter learning progress, streak, XP or skill evidence; edited and deleted challenges are stale',
        async () => {
          const issued = await call('post', `/practice/sessions/${sessionId}/exercises`, {
              count: 1,
            }).expect(201),
            challenge = issued.body.exercises[0];
          const before = (
            await db.adminPool.query('SELECT * FROM product_gotit.learning_items WHERE id=$1', [
              challenge.learningItemId,
            ])
          ).rows[0];
          const xpBefore = (
            await db.adminPool.query('SELECT count(*)::integer count FROM product_gotit.xp_events')
          ).rows[0].count;
          const skipped = await call('post', '/practice/attempts', {
            exerciseId: challenge.id,
            skipped: true,
          }).expect(201);
          assert.equal(skipped.body.attempt.xpEarned, 0);
          assert.deepEqual(
            (
              await db.adminPool.query('SELECT * FROM product_gotit.learning_items WHERE id=$1', [
                challenge.learningItemId,
              ])
            ).rows[0],
            before,
          );
          assert.equal(
            (
              await db.adminPool.query(
                'SELECT count(*)::integer count FROM product_gotit.xp_events',
              )
            ).rows[0].count,
            xpBefore,
          );
          const stale = (
            await call('post', `/practice/sessions/${sessionId}/exercises`, { count: 1 }).expect(
              201,
            )
          ).body.exercises[0];
          await call('patch', `/learning-items/${stale.learningItemId}`, {
            translation: { text: 'changed' },
          }).expect(200);
          await call('post', '/practice/attempts', {
            exerciseId: stale.id,
            answerText: 'hello',
          }).expect(409);
          await call('delete', `/learning-items/${stale.learningItemId}`).expect(200);
          await call('get', `/learning-items/${stale.learningItemId}`).expect(404);
          await call('post', `/learning-items/${stale.learningItemId}/restore`, {}).expect(200);
          await call('patch', `/practice/sessions/${sessionId}`, { status: 'completed' }).expect(
            200,
          );
          await call('post', `/practice/sessions/${sessionId}/exercises`, { count: 1 }).expect(409);
        },
      );
      await t.test(
        'speech sessions explicitly report missing provider instead of producing fabricated assessments',
        async () => {
          const result = await call('post', '/practice/sessions', {
            sessionType: 'pronunciation',
            learningItemIds: ids,
          }).expect(503);
          assert.equal(result.body.error.code, 'SPEECH_NOT_CONFIGURED');
          await call('get', `/learning-items/${ids[0]}/audio`).expect(503);
          await call('get', `/learning-items/${ids[0]}/audio`, undefined, randomUUID(), 1).expect(
            404,
          );
        },
      );
      await t.test(
        'reading preview is not persisted; encrypted publication is scoped, single-use and replays after expiry/deletion',
        async () => {
          const input = { targetLanguageCode: 'en', topic: 'Daily life', learningItemIds: ids };
          const preview = await call('post', '/reading/preview', input).expect(200),
            token = preview.body.publicationToken;
          assert.equal(
            (
              await db.adminPool.query(
                'SELECT count(*)::integer count FROM product_gotit.generated_contents',
              )
            ).rows[0].count,
            0,
          );
          assert.ok(
            !Buffer.from(token, 'base64url').toString('utf8').includes('This is a reading passage'),
          );
          await call('post', '/reading', { publicationToken: token }, randomUUID(), 1).expect(409);
          await call('post', '/reading', { publicationToken: token.slice(0, -3) + 'abc' }).expect(
            409,
          );
          const key = randomUUID(),
            opened = await call('post', '/reading', { publicationToken: token }, key).expect(201),
            id = opened.body.reading.id;
          assert.equal(opened.body.reading.targets.length, 3);
          assert.equal(generationCalls, 1);
          await call('post', '/reading', { publicationToken: token }).expect(409);
          const quiz = await call('post', '/practice/sessions', {
            sessionType: 'article_quiz',
            readingId: id,
          }).expect(201);
          const exercises = await call(
            'post',
            `/practice/sessions/${quiz.body.session.id}/exercises`,
            { count: 1 },
          ).expect(201);
          const item = (
            await db.adminPool.query(
              'SELECT source_text FROM product_gotit.learning_items WHERE id=$1',
              [exercises.body.exercises[0].learningItemId],
            )
          ).rows[0];
          assert.ok(!exercises.body.exercises[0].prompt.context.includes(item.source_text));
          await call('post', '/practice/attempts', {
            exerciseId: exercises.body.exercises[0].id,
            answerText: item.source_text,
          }).expect(201);
          await call('delete', `/reading/${id}`).expect(200);
          await call('get', `/reading/${id}`).expect(404);
          readingClock += 20 * 60000;
          assert.deepEqual(
            (await call('post', '/reading', { publicationToken: token }, key).expect(200)).body
              .reading,
            opened.body.reading,
          );
          const stale = await readings.preview(
            { applicationId, applicationUserId: users[0]! },
            readingInputSchema.parse(input),
          );
          await call('patch', `/learning-items/${ids[0]}`, {
            sourceText: 'a changed expression',
            translation: { text: 'another confirmed meaning' },
          }).expect(200);
          await call('post', '/reading', { publicationToken: stale.publicationToken }).expect(409);
        },
      );
      await t.test(
        'import validates all entries before writes and explicit partial outcomes replay successes; export and dashboard stay scoped',
        async () => {
          const capture = (sourceText: string) => ({
            item: { sourceText, sourceLanguageCode: 'en', translationLanguageCode: 'he' },
            translation: { text: 'imported' },
            context: { selectedText: sourceText, sourceType: 'import' },
            senseDecision: { mode: 'auto' },
          });
          const entries = [
            { eventId: randomUUID(), capture: capture('import one') },
            {
              eventId: randomUUID(),
              capture: {
                ...capture('foreign import'),
                senseDecision: { mode: 'merge', learningItemId: randomUUID() },
              },
            },
          ];
          const envelope = { format: 'capture_requests_v1', entries };
          const initial = await call('post', '/import', envelope).expect(207);
          assert.equal(initial.body.results[0].status, 'succeeded');
          assert.equal(initial.body.results[1].status, 'failed');
          const again = await call('post', '/import', envelope).expect(207);
          assert.deepEqual(
            again.body.results[0].capture.capture,
            initial.body.results[0].capture.capture,
          );
          const exported = await call('get', '/export?limit=2').expect(200);
          assert.equal(exported.body.items.length, 2);
          assert.ok(exported.body.nextCursor);
          assert.ok(!JSON.stringify(exported.body).includes('capture_receipt'));
          assert.ok(
            exported.body.items.every(
              (item: any) =>
                Number.isInteger(item.learningRevision) &&
                Number.isInteger(item.occurrenceCount) &&
                item.skills.length === 5 &&
                typeof item.overallMasteryScore === 'number',
            ),
          );
          assert.equal(
            (await call('get', '/export', undefined, randomUUID(), 1).expect(200)).body.items
              .length,
            0,
          );
          const dashboard = await call('get', '/dashboard').expect(200);
          assert.equal(dashboard.body.counts.total, 4);
          assert.ok(dashboard.body.gamification.totalXp >= 10);
          assert.equal(
            (await call('get', '/dashboard', undefined, randomUUID(), 1).expect(200)).body.counts
              .total,
            0,
          );
          const before = (
            await db.adminPool.query(
              'SELECT count(*)::integer count FROM product_gotit.learning_items',
            )
          ).rows[0].count;
          await call('post', '/import', {
            format: 'capture_requests_v1',
            entries: [
              { eventId: randomUUID(), capture: capture('must not write') },
              { eventId: randomUUID(), capture: { score: 100 } },
            ],
          }).expect(400);
          assert.equal(
            (
              await db.adminPool.query(
                'SELECT count(*)::integer count FROM product_gotit.learning_items',
              )
            ).rows[0].count,
            before,
          );
        },
      );
      await t.test(
        'rate limits share atomic buckets across instances without persisting raw identities',
        async () => {
          const a = new PostgresRateLimiter(db.runtimePool),
            b = new PostgresRateLimiter(db.runtimePool);
          const results = await Promise.all([
            a.consume('private-ip-identity', 2, 60),
            b.consume('private-ip-identity', 2, 60),
            a.consume('private-ip-identity', 2, 60),
          ]);
          assert.equal(results.filter((r) => r.allowed).length, 2);
          assert.ok(results.every((r) => r.retryAfter >= 1));
          const rows = (
            await db.adminPool.query('SELECT bucket_key FROM product_gotit.api_rate_limits')
          ).rows;
          assert.equal(rows.length, 1);
          assert.match(rows[0].bucket_key, /^[a-f0-9]{64}$/u);
          await a.cleanup();
        },
      );
      await t.test(
        'preflight requires current schema and product-only privileges; removing a scope constraint fails closed',
        async () => {
          const { verifyRuntimeSchema } = await import(
            new URL('../../scripts/preflight.js', import.meta.url).href
          );
          const { inspectProduction } = await import(
            new URL('../../scripts/inspect-production.js', import.meta.url).href
          );
          const client = await db.runtimePool.connect();
          try {
            await client.query('BEGIN READ ONLY');
            assert.equal((await verifyRuntimeSchema(client)).role, 'product-only');
          } finally {
            await client.query('ROLLBACK');
            client.release();
          }
          const inspection = await inspectProduction(db.runtimePool.options.connectionString);
          assert.equal(inspection.productTableCount, 22);
          assert.deepEqual(inspection.v1, {
            learningRevision: true,
            captureReceipts: true,
            practiceExercises: true,
            apiRateLimits: true,
          });
          assert.equal(inspection.role.coreTableAccess, false);
          assert.equal(inspection.conflicts.duplicateAttemptSequenceGroups, 0);
          const admin = await db.adminPool.connect();
          try {
            await admin.query('BEGIN');
            await assert.rejects(() => verifyRuntimeSchema(admin), /DEDICATED_RUNTIME_ROLE/u);
            await admin.query(
              'ALTER TABLE product_gotit.practice_exercises DROP CONSTRAINT practice_exercises_session_fkey',
            );
            await assert.rejects(
              () => verifyRuntimeSchema(admin, { strictRole: false }),
              /EXERCISE_SCOPE_CONSTRAINT/u,
            );
          } finally {
            await admin.query('ROLLBACK');
            admin.release();
          }
        },
      );
      await t.test(
        'matching issues one shared shuffled board and records each pair through the owned attempt engine',
        async () => {
          const session = (
            await call('post', '/practice/sessions', {
              sessionType: 'matching',
              learningItemIds: ids,
            }).expect(201)
          ).body.session;
          const result = await call('post', `/practice/sessions/${session.id}/exercises`, {
            count: 3,
          }).expect(201);
          assert.equal(result.body.matchingGroup.choices.length, 3);
          assert.equal(result.body.exercises.length, 3);
          for (const exercise of result.body.exercises) {
            assert.equal(exercise.prompt.groupId, result.body.matchingGroup.id);
            assert.deepEqual(exercise.prompt.choices, result.body.matchingGroup.choices);
            assert.ok(exercise.prompt.choices.every((c: any) => c.correct === undefined));
            const primary = (
              await db.adminPool.query(
                'SELECT translation_text FROM product_gotit.item_translations WHERE learning_item_id=$1 AND is_primary AND is_current',
                [exercise.learningItemId],
              )
            ).rows[0].translation_text;
            const choice = result.body.matchingGroup.choices.find((c: any) => c.text === primary);
            assert.equal(
              (
                await call('post', '/practice/attempts', {
                  exerciseId: exercise.id,
                  choiceId: choice.id,
                }).expect(201)
              ).body.attempt.score,
              100,
            );
          }
          const closed = await call('patch', `/practice/sessions/${session.id}`, {
            status: 'completed',
          }).expect(200);
          const again = await call('patch', `/practice/sessions/${session.id}`, {
            status: 'completed',
          }).expect(200);
          assert.deepEqual(closed.body.session, again.body.session);
          const daily = (
              await db.adminPool.query(
                'SELECT sum(xp_earned)::integer xp FROM product_gotit.user_daily_activity',
              )
            ).rows[0].xp,
            ledger = (
              await db.adminPool.query(
                'SELECT sum(xp_amount)::integer xp FROM product_gotit.xp_events',
              )
            ).rows[0].xp;
          assert.equal(daily, ledger);
        },
      );
      await t.test(
        'late attempt failure rolls back evidence, progress, XP, daily counters and exercise consumption; retry uses the same key',
        async () => {
          const session = (
            await call('post', '/practice/sessions', {
              sessionType: 'recall',
              learningItemIds: [ids[1]],
            }).expect(201)
          ).body.session;
          const exercise = (
            await call('post', `/practice/sessions/${session.id}/exercises`, { count: 1 }).expect(
              201,
            )
          ).body.exercises[0];
          const item = (
            await db.adminPool.query(
              'SELECT source_text FROM product_gotit.learning_items WHERE id=$1',
              [ids[1]],
            )
          ).rows[0];
          const key = randomUUID(),
            input = { exerciseId: exercise.id, answerText: item.source_text };
          const before = (
            await db.adminPool.query(
              'SELECT count(*)::integer attempts FROM product_gotit.practice_attempts',
            )
          ).rows[0].attempts;
          await db.adminPool.query(
            'ALTER TABLE product_gotit.user_daily_activity ADD CONSTRAINT reject_attempt_test CHECK(attempts<0) NOT VALID',
          );
          try {
            await call('post', '/practice/attempts', input, key).expect(503);
            assert.equal(
              (
                await db.adminPool.query(
                  'SELECT consumed_at FROM product_gotit.practice_exercises WHERE id=$1',
                  [exercise.id],
                )
              ).rows[0].consumed_at,
              null,
            );
            assert.equal(
              (
                await db.adminPool.query(
                  'SELECT count(*)::integer attempts FROM product_gotit.practice_attempts',
                )
              ).rows[0].attempts,
              before,
            );
          } finally {
            await db.adminPool.query(
              'ALTER TABLE product_gotit.user_daily_activity DROP CONSTRAINT reject_attempt_test',
            );
          }
          await call('post', '/practice/attempts', input, key).expect(201);
          await call('post', '/practice/attempts', input, key).expect(200);
        },
      );
      await t.test(
        'verified speech results feed the same transactional engine; retry skips the provider and raw audio is never persisted',
        async () => {
          let calls = 0;
          const provider = {
            id: 'test_speech',
            supports: (language: string) => language === 'en',
            synthesize: async () => ({
              audio: Buffer.from('fake reference'),
              contentType: 'audio/mpeg' as const,
            }),
            assess: async (input: { audio: Buffer }) => {
              calls++;
              assert.equal(input.audio.length, 3244);
              return { score: 90, feedback: 'Good pronunciation', model: 'test_voice' };
            },
          };
          const scope = { applicationId, applicationUserId: users[0]! };
          await profiles.patchProfile(scope, {
            learningPreferences: {
              enabledSkills: ['recognition', 'recall', 'spelling', 'pronunciation'],
            },
          });
          const practice = new PracticeService(
            db.runtimePool,
            profiles,
            undefined,
            (language, kind) => provider.supports(language),
          );
          const speech = new SpeechService(db.runtimePool, practice, provider);
          const session = await practice.createSession(
            scope,
            randomUUID(),
            sessionSchema.parse({ sessionType: 'pronunciation', learningItemIds: [ids[0]] }),
          );
          const issued = await practice.issueExercises(
              scope,
              session.session.id as string,
              exercisesSchema.parse({ count: 1 }),
            ),
            exercise = issued.exercises[0]!;
          assert.equal(exercise.prompt.text, 'a changed expression');
          const audio = Buffer.alloc(3244);
          audio.write('RIFF');
          audio.writeUInt32LE(3236, 4);
          audio.write('WAVEfmt ', 8);
          audio.writeUInt32LE(16, 16);
          audio.writeUInt16LE(1, 20);
          audio.writeUInt16LE(1, 22);
          audio.writeUInt32LE(16000, 24);
          audio.writeUInt32LE(32000, 28);
          audio.writeUInt16LE(2, 32);
          audio.writeUInt16LE(16, 34);
          audio.write('data', 36);
          audio.writeUInt32LE(3200, 40);
          const key = randomUUID(),
            result = await speech.assess(scope, key, exercise.id, audio),
            again = await speech.assess(scope, key, exercise.id, audio);
          assert.deepEqual(again.attempt, result.attempt);
          assert.equal(calls, 1);
          assert.equal(result.attempt.score, 90);
          const stored = (
            await db.adminPool.query(
              'SELECT user_answer_text FROM product_gotit.practice_attempts WHERE id=$1',
              [result.attempt.id],
            )
          ).rows[0].user_answer_text;
          assert.ok(stored.includes('Good pronunciation'));
          assert.ok(!stored.includes(audio.toString('base64')));
          const changed = Buffer.from(audio);
          changed[changed.length - 1] = 1;
          await assert.rejects(
            () => speech.assess(scope, key, exercise.id, changed),
            (error: any) => error.code === 'IDEMPOTENCY_CONFLICT',
          );
        },
      );
      await t.test(
        'historical reading stays scoped and invalid provider output never becomes a publication',
        async () => {
          const scope = { applicationId, applicationUserId: users[0]! },
            id = randomUUID();
          await db.adminPool.query(
            `INSERT INTO product_gotit.generated_contents(id,application_id,application_user_id,content_type,topic,target_language_code,length_preset,title,body_text,provider_name,opened_at) VALUES($1,$2,$3,'article','History','en','short','Original title','Original stored passage for historical reading.','historical_provider',now())`,
            [id, applicationId, users[0]],
          );
          const historical = (await call('get', `/reading/${id}`).expect(200)).body.reading;
          assert.equal(historical.bodyText, 'Original stored passage for historical reading.');
          await call('get', `/reading/${id}`, undefined, randomUUID(), 1).expect(404);
          const invalid = new ReadingService(
            db.runtimePool,
            profiles,
            practices,
            {
              id: 'invalid_provider',
              generate: async () => ({ title: '', bodyText: 'invalid', providerModel: null }),
            },
            'r'.repeat(32),
          );
          await assert.rejects(
            () =>
              invalid.preview(
                scope,
                readingInputSchema.parse({
                  topic: 'Test',
                  targetLanguageCode: 'en',
                  learningItemIds: [ids[1]],
                }),
              ),
            (error: any) => error.statusCode === 503 && error.code === 'READING_UNAVAILABLE',
          );
          assert.equal(
            (
              await db.adminPool.query(
                'SELECT publication_receipt FROM product_gotit.generated_contents WHERE id=$1',
                [id],
              )
            ).rows[0].publication_receipt,
            null,
          );
        },
      );
      await t.test(
        'concurrent correct answers obey the daily XP cap while retaining evidence and meaningful activity',
        async () => {
          const scope = { applicationId, applicationUserId: users[1]! },
            capture = new CaptureService(
              new CaptureRepository(db.runtimePool),
              profiles,
              new EnrichmentRegistry(),
              new SelectionProofs(undefined),
            );
          const saved = await capture.save(
            scope,
            randomUUID(),
            saveSchema.parse({
              item: {
                sourceText: 'bounded reward',
                sourceLanguageCode: 'en',
                translationLanguageCode: 'he',
              },
              translation: { text: 'confirmed reward' },
              context: { selectedText: 'bounded reward', sourceType: 'import' },
              senseDecision: { mode: 'auto' },
            }),
          );
          const id = saved.capture.learningItemId;
          const limited = new PracticeService(
            db.runtimePool,
            profiles,
            policySchema.parse({ dailyXpCap: 7 }),
          );
          const session = await limited.createSession(
            scope,
            randomUUID(),
            sessionSchema.parse({ sessionType: 'recall', learningItemIds: [id] }),
          );
          const issued = await limited.issueExercises(
            scope,
            session.session.id,
            exercisesSchema.parse({ count: 2 }),
          );
          const results = await Promise.all(
            issued.exercises.map((exercise) =>
              limited.submitAttempt(scope, randomUUID(), {
                exerciseId: exercise.id,
                answerText: 'bounded reward',
                hintsUsed: 0,
                skipped: false,
              }),
            ),
          );
          assert.equal(
            results.reduce((total, result) => total + result.attempt.xpEarned, 0),
            7,
          );
          const totals = (
            await db.adminPool.query(
              'SELECT total_xp,current_streak_days FROM product_gotit.user_gamification WHERE application_id=$1 AND application_user_id=$2',
              [applicationId, users[1]],
            )
          ).rows[0];
          assert.equal(Number(totals.total_xp), 7);
          assert.equal(totals.current_streak_days, 1);
          const daily = (
            await db.adminPool.query(
              'SELECT attempts,xp_earned FROM product_gotit.user_daily_activity WHERE application_id=$1 AND application_user_id=$2',
              [applicationId, users[1]],
            )
          ).rows[0];
          assert.equal(daily.attempts, 2);
          assert.equal(daily.xp_earned, 7);
        },
      );
      await t.test(
        'reviewed role provisioning allows only GotIt migrations and a product-only production runtime',
        async () => {
          const runtimeSql = await readFile(
              new URL('../../scripts/provision-runtime.sql', import.meta.url),
              'utf8',
            ),
            migratorSql = await readFile(
              new URL('../../scripts/provision-migrator.sql', import.meta.url),
              'utf8',
            );
          const coreBefore = (
            await db.adminPool.query(
              "SELECT relowner FROM pg_class WHERE oid='core.application_users'::regclass",
            )
          ).rows;
          await db.adminPool.query(runtimeSql);
          await db.adminPool.query(migratorSql);
          assert.ok(
            (
              await db.adminPool.query(
                `SELECT count(*)::integer count FROM information_schema.role_table_grants WHERE table_schema='product_gotit' AND grantee=current_user AND privilege_type IN('SELECT','INSERT','UPDATE','DELETE')`,
              )
            ).rows[0].count >= 80,
          );
          const adminUrl = db.adminPool.options.connectionString!;
          const migratorUrl = adminUrl.replace('://postgres@', '://gotit_migrator@');
          const { migrate } = await import(
            new URL('../../scripts/migrate.js', import.meta.url).href
          );
          await migrate(migratorUrl, 'down');
          await migrate(migratorUrl, 'up');
          const runtime = new pg.Pool({
            connectionString: adminUrl.replace('://postgres@', '://gotit_runtime@'),
            connectionTimeoutMillis: 1000,
          });
          try {
            const { verifyRuntimeSchema } = await import(
              new URL('../../scripts/preflight.js', import.meta.url).href
            );
            assert.equal((await verifyRuntimeSchema(runtime)).role, 'product-only');
            await assert.rejects(() => runtime.query('SELECT * FROM core.application_users'));
            await assert.rejects(() =>
              runtime.query('CREATE TABLE product_gotit.disallowed(id integer)'),
            );
          } finally {
            await runtime.end();
          }
          assert.deepEqual(
            (
              await db.adminPool.query(
                "SELECT relowner FROM pg_class WHERE oid='core.application_users'::regclass",
              )
            ).rows,
            coreBefore,
          );
        },
      );
    } finally {
      await db.dispose();
    }
  },
);
