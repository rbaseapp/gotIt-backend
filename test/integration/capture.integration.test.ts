import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Writable } from 'node:stream';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { CaptureRepository } from '../../src/modules/capture/capture.repository.js';
import { CaptureService } from '../../src/modules/capture/capture.service.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import { EnrichmentRegistry } from '../../src/modules/enrichment/enrichment.registry.js';
import { SelectionProofs } from '../../src/modules/enrichment/selection-proof.js';
import type { EnrichmentProvider } from '../../src/modules/enrichment/enrichment.types.js';
import { CoreAuthClient } from '../../src/shared/core/core-auth.client.js';
import { createLogger } from '../../src/shared/logger/logger.js';
import { createTestDatabase } from '../helpers/postgres.js';

test(
  'capture atomicity, isolation, durable replay and extensible enrichment on disposable PostgreSQL',
  { timeout: 150000 },
  async (t) => {
    const database = await createTestDatabase();
    try {
      const applicationId = randomUUID(),
        otherApplicationId = randomUUID();
      const scopes = [
        { applicationId, applicationUserId: randomUUID() },
        { applicationId, applicationUserId: randomUUID() },
        { applicationId: otherApplicationId, applicationUserId: randomUUID() },
      ];
      await database.adminPool.query(
        `INSERT INTO core.applications(id,key,name) VALUES ($1,'gotit','GotIt Capture'),($2,'other','Other')`,
        [applicationId, otherApplicationId],
      );
      for (const [index, scope] of scopes.entries())
        await database.adminPool.query(
          `INSERT INTO core.application_users(id,application_id,email) VALUES ($1,$2,$3)`,
          [scope.applicationUserId, scope.applicationId, `capture-${index}@example.test`],
        );
      let authCalls = 0,
        providerCalls = 0,
        now = Date.now();
      const coreAuthClient = new CoreAuthClient({
        baseUrl: 'https://core.example.test',
        applicationKey: 'gotit',
        timeoutMs: 1000,
        fetchImpl: async (_url, init) => {
          authCalls++;
          const index = Number(
            new Headers(init?.headers).get('authorization')?.replace('Bearer user-', ''),
          );
          const scope = scopes[index];
          return scope
            ? Response.json({
                user: { id: scope.applicationUserId, applicationId: scope.applicationId },
              })
            : new Response(null, { status: 401 });
        },
      });
      const profileService = new ProfileService(new ProfileRepository(database.runtimePool));
      const repository = new CaptureRepository(database.runtimePool);
      const adapter: EnrichmentProvider = {
        id: 'additional_ai',
        kind: 'ai',
        capabilities: {
          detection: false,
          context: true,
          phonetics: false,
          examples: true,
          models: true,
        },
        enrich: async (input) => {
          providerCalls++;
          return {
            sourceLanguageCode: input.sourceLanguageCode,
            candidates: [
              {
                text: 'fee',
                variants: ['cost'],
                partOfSpeech: 'verb',
                examples: ['They charge a small fee.'],
                contextUsed: !!input.sentenceText,
              },
            ],
          };
        },
      };
      const registry = new EnrichmentRegistry(
        [adapter],
        [{ id: 'ai_default', providerId: adapter.id, model: 'model-one', timeoutMs: 1000 }],
        { ai: { profiles: ['ai_default'], timeoutMs: 1000 } },
      );
      const proofs = new SelectionProofs('s'.repeat(32), () => now);
      let logs = '';
      const sink = new Writable({
        write(chunk, _encoding, callback) {
          logs += chunk.toString();
          callback();
        },
      });
      const app = createApp({
        logger: createLogger('info', sink),
        coreAuthClient,
        profileService,
        captureService: new CaptureService(repository, profileService, registry, proofs),
        checkDatabase: async () => {
          await database.runtimePool.query('SELECT 1');
        },
      });
      const body = (sourceText = `word-${randomUUID()}`, text = 'translation') => ({
        item: {
          sourceText,
          sourceLanguageCode: 'en',
          translationLanguageCode: 'he',
          itemType: 'word',
        },
        translation: { text, variants: [] as string[] },
        context: {
          selectedText: sourceText,
          sentenceText: 'An original sentence.',
          pageUrl: 'https://EXAMPLE.TEST:443/a?private=context#section',
        },
        senseDecision: { mode: 'auto' } as {
          mode: 'auto' | 'create_new_sense' | 'merge';
          learningItemId?: string;
        },
      });
      const save = (input: object, key = randomUUID(), user = 0) =>
        request(app)
          .post('/api/v1/captures')
          .set('Authorization', `Bearer user-${user}`)
          .set('Idempotency-Key', key)
          .send(input);
      const preview = (input: object, user = 0) =>
        request(app)
          .post('/api/v1/captures/preview')
          .set('Authorization', `Bearer user-${user}`)
          .send(input);
      const detail = (id: string, user = 0) =>
        request(app)
          .get(`/api/v1/learning-items/${id}`)
          .set('Authorization', `Bearer user-${user}`);
      const counts = async () => {
        const result: Record<string, number> = {};
        for (const table of [
          'learning_items',
          'item_translations',
          'item_occurrences',
          'item_skill_progress',
          'item_examples',
          'xp_events',
        ]) {
          const count = await database.adminPool.query(
            `SELECT count(*)::integer AS count FROM product_gotit.${table}`,
          );
          result[table] = count.rows[0].count;
        }
        return result;
      };
      const updateItem = async (id: string, sql: string) =>
        database.adminPool.query(
          `UPDATE product_gotit.learning_items SET ${sql}
        WHERE application_id=$1 AND application_user_id=$2 AND id=$3`,
          [applicationId, scopes[0]!.applicationUserId, id],
        );

      await t.test(
        'GotIt migration rerun/down/up and baseline guards preserve the 20-table history',
        async () => {
          await database.migrate();
          const metadata = await database.adminPool.query(
            'SELECT count(*)::integer AS count FROM gotit_migrations.pgmigrations',
          );
          assert.equal(metadata.rows[0].count, 2);
          const originalCore = await database.adminPool.query(
            'SELECT count(*)::integer AS count FROM public.pgmigrations',
          );
          const legacyId = randomUUID(),
            legacyOccurrenceId = randomUUID();
          await database.adminPool.query(
            `INSERT INTO product_gotit.learning_items
          (id,application_id,application_user_id,source_text,normalized_source_text,source_language_code,translation_language_code,item_type)
          VALUES ($1,$2,$3,'migration legacy','migration legacy','en','he','word')`,
            [legacyId, applicationId, scopes[0]!.applicationUserId],
          );
          await database.adminPool.query(
            `INSERT INTO product_gotit.item_occurrences
          (id,application_id,application_user_id,learning_item_id,source_type,selected_text,client_event_id)
          VALUES ($1,$2,$3,$4,'api','legacy original selection',$5)`,
            [
              legacyOccurrenceId,
              applicationId,
              scopes[0]!.applicationUserId,
              legacyId,
              randomUUID(),
            ],
          );
          await database.migrate('down');
          await database.migrate('down');
          const absent = await database.adminPool
            .query(`SELECT column_name FROM information_schema.columns WHERE table_schema='product_gotit'
          AND table_name='item_occurrences' AND column_name='capture_receipt'`);
          assert.equal(absent.rows.length, 0);
          await database.migrate('up');
          const legacy = await database.adminPool.query(
            'SELECT selected_text,capture_request_hash,capture_receipt FROM product_gotit.item_occurrences WHERE id=$1',
            [legacyOccurrenceId],
          );
          assert.deepEqual(legacy.rows[0], {
            selected_text: 'legacy original selection',
            capture_request_hash: null,
            capture_receipt: null,
          });
          for (const update of [
            "capture_request_hash='" + 'a'.repeat(64) + "'",
            'capture_request_hash=\'bad\',capture_receipt=\'{"version":1,"httpStatus":201,"capture":{}}\'',
            "capture_request_hash='" +
              'a'.repeat(64) +
              '\',capture_receipt=\'{"version":1,"httpStatus":503,"capture":{}}\'',
            "capture_request_hash='" +
              'a'.repeat(64) +
              '\',capture_receipt=\'{"version":1,"httpStatus":201}\'',
          ])
            await assert.rejects(
              () =>
                database.adminPool.query(
                  `UPDATE product_gotit.item_occurrences SET ${update} WHERE id=$1`,
                  [legacyOccurrenceId],
                ),
              (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === '23514',
            );
          assert.deepEqual(
            (
              await database.adminPool.query(
                'SELECT count(*)::integer AS count FROM public.pgmigrations',
              )
            ).rows,
            originalCore.rows,
          );
          const migrations = await import(pathToFileURL(resolve('scripts/migrate.js')).href);
          const client = await database.adminPool.connect();
          try {
            await client.query('BEGIN');
            await client.query(
              'ALTER TABLE product_gotit.item_occurrences DROP CONSTRAINT item_occurrences_learning_item_fkey',
            );
            await assert.rejects(
              () => migrations.verifyBaseline(client),
              /scoped GotIt baseline foreign key/u,
            );
          } finally {
            await client.query('ROLLBACK');
            client.release();
          }
          await assert.rejects(
            () => migrations.verifyBaseline({ query: async () => ({ rows: [] }) }),
            /baseline tables/u,
          );
          await assert.rejects(
            () => migrations.migrate(undefined),
            /GOTIT_MIGRATION_DATABASE_URL/u,
          );
          await assert.rejects(
            () => database.runtimePool.query('SELECT * FROM core.application_users'),
            (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === '42501',
          );
        },
      );
      await t.test(
        'manual preview uses profile languages and ignores document language metadata',
        async () => {
          const before = await counts();
          const unresolved = await preview({ selectedText: 'charge' }).expect(200);
          assert.equal(unresolved.body.preview.requiresLanguageSelection, true);
          assert.equal(unresolved.body.preview.enrichment.status, 'needs_language_selection');
          await profileService.patchProfile(scopes[0]!, {
            defaultSourceLanguage: 'en',
            defaultTranslationLanguage: 'he',
          });
          const manual = await preview({
            selectedText: 'charge',
            documentLanguageHint: 'ar',
            context: { paragraphText: 'explicit only' },
          }).expect(200);
          assert.equal(manual.body.preview.sourceLanguageCode, 'en');
          assert.equal(manual.body.preview.sourceLanguageResolution, 'profile');
          assert.equal(manual.body.preview.translationLanguageResolution, 'profile');
          assert.equal(manual.body.preview.enrichment.status, 'not_configured');
          assert.equal(providerCalls, 0);
          assert.equal(manual.headers['cache-control'], 'no-store');
          assert.deepEqual(await counts(), before);
          const traces = await database.adminPool.query(
            'SELECT count(*)::integer AS count FROM product_gotit.enrichment_runs',
          );
          assert.equal(traces.rows[0].count, 0);
        },
      );
      await t.test(
        'first save creates primary/variants, occurrence/receipt and five zero-evidence skills without XP',
        async () => {
          const input = body(' charge ', 'fee');
          input.translation.variants = ['cost'];
          const result = await save(input).expect(201);
          assert.equal(result.headers['idempotency-replayed'], 'false');
          const item = (await detail(result.body.capture.learningItemId).expect(200)).body
            .learningItem;
          assert.equal(item.sourceText, 'charge');
          assert.equal(item.userStatus, 'active');
          assert.equal(item.learningStatus, 'new');
          assert.equal(item.overallMasteryScore, 0);
          assert.equal(item.reviewStage, 0);
          assert.equal(item.nextReviewAt, null);
          assert.equal(item.skills.length, 5);
          assert.ok(
            item.skills.every(
              (s: { attemptCount: number; masteryScore: number }) =>
                s.attemptCount === 0 && s.masteryScore === 0,
            ),
          );
          assert.equal(item.translations.length, 2);
          assert.ok(
            item.translations.every(
              (tr: { sourceKind: string; isUserEdited: boolean }) =>
                tr.sourceKind === 'user' && tr.isUserEdited,
            ),
          );
          const occurrence = await database.adminPool.query(
            'SELECT * FROM product_gotit.item_occurrences WHERE id=$1',
            [result.body.capture.occurrenceId],
          );
          assert.equal(occurrence.rows[0].page_hostname, 'example.test');
          assert.equal(occurrence.rows[0].paragraph_text, null);
          assert.equal(occurrence.rows[0].capture_receipt.version, 1);
          assert.equal(occurrence.rows[0].capture_receipt.httpStatus, 201);
          assert.equal('requestId' in occurrence.rows[0].capture_receipt, false);
          assert.equal('capture_receipt' in item, false);
          assert.equal((await counts()).xp_events, 0);
        },
      );
      await t.test(
        'ambiguous auto requires explicit sense; merge preserves progress, primary and metadata',
        async () => {
          const ambiguous = await save(body('CHARGE', 'different')).expect(409);
          assert.equal(ambiguous.body.error.code, 'SENSE_SELECTION_REQUIRED');
          const id = ambiguous.body.error.details.existingSenses.items[0].learningItemId;
          await updateItem(
            id,
            "user_status='paused',learning_status='reviewing',overall_mastery_score=75,review_stage=4,part_of_speech='original',next_review_at='2030-01-01Z'",
          );
          await database.adminPool.query(
            `UPDATE product_gotit.item_translations SET is_user_edited=true WHERE learning_item_id=$1 AND is_primary`,
            [id],
          );
          await database.adminPool.query(
            `UPDATE product_gotit.item_skill_progress SET attempt_count=7,mastery_score=42 WHERE learning_item_id=$1 AND skill_type='recall'`,
            [id],
          );
          const merge = body('charge', 'new wording');
          merge.senseDecision = { mode: 'merge', learningItemId: id };
          merge.translation.variants = ['cost'];
          const result = await save(merge).expect(200);
          assert.equal(result.body.capture.primaryTranslation, 'fee');
          assert.equal(result.body.capture.outcome, 'merged');
          const item = (await detail(id).expect(200)).body.learningItem;
          assert.equal(item.userStatus, 'paused');
          assert.equal(item.overallMasteryScore, 75);
          assert.equal(item.reviewStage, 4);
          assert.equal(item.partOfSpeech, 'original');
          assert.equal(
            item.skills.find((s: { skillType: string }) => s.skillType === 'recall').attemptCount,
            7,
          );
          assert.equal(item.translations.length, 3);
          assert.equal(item.occurrenceCount, 2);
          const newSense = body('charge', 'fee');
          newSense.senseDecision = { mode: 'create_new_sense' };
          const distinct = await save(newSense).expect(201);
          assert.notEqual(distinct.body.capture.learningItemId, id);
          assert.equal(distinct.body.capture.outcome, 'created_new_sense');
          const candidates = await preview({
            selectedText: 'charge',
            sourceLanguageCode: 'en',
            translationLanguageCode: 'he',
          }).expect(200);
          assert.equal(candidates.body.preview.existingSenses.items.length, 2);
          await updateItem(id, "user_status='archived'");
          assert.equal(
            (
              await preview({
                selectedText: 'charge',
                sourceLanguageCode: 'en',
                translationLanguageCode: 'he',
              }).expect(200)
            ).body.preview.existingSenses.items.length,
            2,
          );
        },
      );
      await t.test(
        'replay returns the original snapshot after later edits/deletion and always reauthenticates',
        async () => {
          const input = body(),
            key = randomUUID();
          const original = await save(input, key).expect(201);
          await updateItem(
            original.body.capture.learningItemId,
            "source_text='edited',user_status='archived',deleted_at=now()",
          );
          const calls = authCalls;
          const replay = await save(input, key).set('x-request-id', 'replay-request').expect(201);
          assert.deepEqual(replay.body.capture, original.body.capture);
          assert.equal(replay.headers['idempotency-replayed'], 'true');
          assert.equal(replay.body.requestId, 'replay-request');
          assert.equal(authCalls, calls + 1);
          await detail(original.body.capture.learningItemId).expect(404);
          const conflict = await save({ ...input, translation: { text: 'changed' } }, key).expect(
            409,
          );
          assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
          await request(app)
            .post('/api/v1/captures')
            .set('Idempotency-Key', key)
            .send(input)
            .expect(401);
        },
      );
      await t.test(
        'concurrent identical keys persist once; conflicting intents and lexical auto saves serialize',
        async () => {
          const input = body(),
            key = randomUUID();
          const before = await counts();
          const [a, b] = await Promise.all([save(input, key), save(input, key)]);
          assert.equal(a.status, 201);
          assert.equal(b.status, 201);
          assert.deepEqual(a.body.capture, b.body.capture);
          assert.deepEqual(
            [a.headers['idempotency-replayed'], b.headers['idempotency-replayed']].sort(),
            ['false', 'true'],
          );
          const after = await counts();
          assert.equal(after.learning_items! - before.learning_items!, 1);
          assert.equal(after.item_occurrences! - before.item_occurrences!, 1);
          const conflictInput = body(),
            conflictKey = randomUUID();
          const conflicts = await Promise.all([
            save(conflictInput, conflictKey),
            save({ ...conflictInput, translation: { text: 'alternative' } }, conflictKey),
          ]);
          assert.deepEqual(conflicts.map((r) => r.status).sort(), [201, 409]);
          const lexical = body();
          const lexicalResults = await Promise.all([save(lexical), save(lexical)]);
          assert.deepEqual(lexicalResults.map((r) => r.status).sort(), [201, 409]);
        },
      );
      await t.test(
        'users/applications own independent keys and senses; foreign/stale/deleted detail and merge stay scoped',
        async () => {
          const input = body(),
            key = randomUUID();
          const a = await save(input, key, 0).expect(201),
            b = await save(input, key, 1).expect(201),
            c = await save(input, key, 2).expect(201);
          assert.notEqual(a.body.capture.learningItemId, b.body.capture.learningItemId);
          assert.notEqual(b.body.capture.learningItemId, c.body.capture.learningItemId);
          const foreign = await detail(a.body.capture.learningItemId, 1).expect(404);
          const missing = await detail(randomUUID(), 1).expect(404);
          assert.deepEqual(foreign.body.error, missing.body.error);
          const merge = {
            ...input,
            senseDecision: { mode: 'merge', learningItemId: a.body.capture.learningItemId },
          };
          await save(merge, randomUUID(), 1).expect(404);
          await save(merge, randomUUID(), 2).expect(404);
          await updateItem(a.body.capture.learningItemId, "normalized_source_text='changed'");
          assert.equal((await save(merge).expect(409)).body.error.code, 'MERGE_ITEM_CHANGED');
          await updateItem(a.body.capture.learningItemId, 'deleted_at=now()');
          await save(merge).expect(404);
          await save({ ...body(), applicationId: otherApplicationId }).expect(400);
          await detail(b.body.capture.learningItemId)
            .query({ applicationUserId: scopes[1]!.applicationUserId })
            .expect(404);
        },
      );
      await t.test(
        'late occurrence failure rolls back all capture writes and same-key retry succeeds once',
        async () => {
          const input = body(),
            key = randomUUID();
          const before = await counts();
          await database.adminPool.query(
            `ALTER TABLE product_gotit.item_occurrences ADD CONSTRAINT capture_test_failure CHECK (client_event_id <> '${key}') NOT VALID`,
          );
          try {
            const result = await save(input, key).expect(503);
            assert.equal(result.body.error.code, 'CAPTURE_TEMPORARILY_UNAVAILABLE');
            assert.deepEqual(await counts(), before);
          } finally {
            await database.adminPool.query(
              'ALTER TABLE product_gotit.item_occurrences DROP CONSTRAINT capture_test_failure',
            );
          }
          const success = await save(input, key).expect(201);
          const replay = await save(input, key).expect(201);
          assert.deepEqual(success.body.capture, replay.body.capture);
        },
      );
      await t.test(
        'blocked merge reaches its lock deadline, rolls back and can retry with the same key',
        async () => {
          const input = body(),
            first = await save(input).expect(201),
            id = first.body.capture.learningItemId;
          const merged = { ...input, senseDecision: { mode: 'merge', learningItemId: id } },
            key = randomUUID(),
            before = await counts();
          const locker = await database.adminPool.connect();
          try {
            await locker.query('BEGIN');
            await locker.query(
              'SELECT id FROM product_gotit.learning_items WHERE id=$1 FOR UPDATE',
              [id],
            );
            const started = Date.now();
            const result = await save(merged, key).expect(503);
            assert.equal(result.body.error.code, 'CAPTURE_TEMPORARILY_UNAVAILABLE');
            assert.ok(Date.now() - started >= 2500 && Date.now() - started < 6500);
            assert.deepEqual(await counts(), before);
          } finally {
            await locker.query('ROLLBACK');
            locker.release();
          }
          await save(merged, key).expect(200);
          assert.equal(
            (await save(merged, key).expect(200)).headers['idempotency-replayed'],
            'true',
          );
        },
      );
      await t.test(
        'legacy missing primary/skills is completed without resetting evidence or translation provenance',
        async () => {
          const input = body(),
            first = await save(input).expect(201),
            id = first.body.capture.learningItemId;
          await database.adminPool.query(
            'UPDATE product_gotit.item_translations SET is_primary=false WHERE learning_item_id=$1',
            [id],
          );
          await database.adminPool.query(
            "DELETE FROM product_gotit.item_skill_progress WHERE learning_item_id=$1 AND skill_type='spelling'",
            [id],
          );
          await database.adminPool.query(
            "UPDATE product_gotit.item_skill_progress SET attempt_count=9 WHERE learning_item_id=$1 AND skill_type='recall'",
            [id],
          );
          const merged = await save({
            ...input,
            senseDecision: { mode: 'merge', learningItemId: id },
          }).expect(200);
          assert.equal(merged.body.capture.primaryTranslation, 'translation');
          const item = (await detail(id).expect(200)).body.learningItem;
          assert.equal(item.skills.length, 5);
          assert.equal(
            item.skills.find((s: { skillType: string }) => s.skillType === 'recall').attemptCount,
            9,
          );
          assert.equal(item.translations.length, 1);
          assert.equal(item.translations[0].isUserEdited, true);
        },
      );
      await t.test(
        'legacy event cannot be recreated; invalid stored receipt returns safe 500',
        async () => {
          const input = body(),
            key = randomUUID();
          const first = await save(input, key).expect(201);
          await database.adminPool.query(
            'UPDATE product_gotit.item_occurrences SET capture_receipt=NULL,capture_request_hash=NULL WHERE id=$1',
            [first.body.capture.occurrenceId],
          );
          assert.equal(
            (await save(input, key).expect(409)).body.error.code,
            'IDEMPOTENCY_LEGACY_EVENT',
          );
          const corruptInput = body(),
            corruptKey = randomUUID(),
            corrupt = await save(corruptInput, corruptKey).expect(201);
          await database.adminPool.query(
            `UPDATE product_gotit.item_occurrences SET capture_receipt=jsonb_set(capture_receipt,'{capture}', '{}'::jsonb) WHERE id=$1`,
            [corrupt.body.capture.occurrenceId],
          );
          const before = await counts();
          assert.equal(
            (await save(corruptInput, corruptKey).expect(500)).body.error.code,
            'INTERNAL_ERROR',
          );
          assert.deepEqual(await counts(), before);
        },
      );
      await t.test(
        'verified provider preview writes metadata only, then save links provenance/examples atomically',
        async () => {
          const sourceText = `provider-${randomUUID()}`,
            sentenceText = 'They charge a fee.';
          const before = await counts();
          const result = await preview({
            selectedText: sourceText,
            sourceLanguageCode: 'en',
            translationLanguageCode: 'he',
            translationMethod: 'ai',
            context: {
              sentenceText,
              pageUrl: 'https://example.test/secret',
              paragraphText: 'private paragraph',
              pageTitle: 'private title',
            },
          }).expect(200);
          assert.deepEqual(await counts(), before);
          assert.equal(result.body.preview.enrichment.status, 'succeeded');
          const candidate = result.body.preview.enrichment.candidates[0];
          const input = {
            ...body(sourceText, 'fee'),
            item: { ...body(sourceText).item, partOfSpeech: candidate.partOfSpeech },
            translation: {
              text: candidate.text,
              variants: candidate.variants,
              selectionToken: candidate.selectionToken,
            },
            context: { selectedText: sourceText, sentenceText },
          };
          const key = randomUUID(),
            saved = await save(input, key).expect(201),
            id = saved.body.capture.learningItemId;
          const item = (await detail(id).expect(200)).body.learningItem;
          assert.ok(
            item.translations.every(
              (tr: { sourceKind: string; providerModel: string; isUserEdited: boolean }) =>
                tr.sourceKind === 'ai' && tr.providerModel === 'model-one' && !tr.isUserEdited,
            ),
          );
          const examples = await database.adminPool.query(
            'SELECT * FROM product_gotit.item_examples WHERE learning_item_id=$1',
            [id],
          );
          assert.equal(examples.rows.length, 1);
          const trace = await database.adminPool.query(
            'SELECT * FROM product_gotit.enrichment_runs WHERE learning_item_id=$1',
            [id],
          );
          assert.equal(trace.rows.length, 1);
          assert.equal(trace.rows[0].status, 'succeeded');
          const used = await save({ ...input, senseDecision: { mode: 'create_new_sense' } }).expect(
            409,
          );
          assert.equal(used.body.error.code, 'ENRICHMENT_SELECTION_ALREADY_USED');
          await save({ ...input, senseDecision: { mode: 'merge', learningItemId: id } }).expect(
            200,
          );
          now += 600001;
          const replay = await save(input, key).expect(201);
          assert.equal(replay.headers['idempotency-replayed'], 'true');
          assert.deepEqual(replay.body.capture, saved.body.capture);
          assert.equal(
            (await save(input).expect(400)).body.error.code,
            'ENRICHMENT_SELECTION_EXPIRED',
          );
          now = Date.now();
        },
      );
      await t.test(
        'tampered/foreign/edited proofs cannot write; late provider save failure leaves trace unlinked',
        async () => {
          const sourceText = `proof-${randomUUID()}`,
            sentenceText = 'Original provider sentence.';
          const result = await preview({
            selectedText: sourceText,
            sourceLanguageCode: 'en',
            translationLanguageCode: 'he',
            translationMethod: 'ai',
            context: { sentenceText },
          }).expect(200);
          const candidate = result.body.preview.enrichment.candidates[0];
          const input = {
            ...body(sourceText, 'fee'),
            item: { ...body(sourceText).item, partOfSpeech: candidate.partOfSpeech },
            translation: {
              text: candidate.text,
              variants: candidate.variants,
              selectionToken: candidate.selectionToken,
            },
            context: { selectedText: sourceText, sentenceText },
          };
          const before = await counts();
          await save(input, randomUUID(), 1).expect(400);
          await save({
            ...input,
            context: { selectedText: sourceText, sentenceText: 'edited' },
          }).expect(400);
          await save({
            ...input,
            translation: {
              ...input.translation,
              selectionToken: `${candidate.selectionToken.split('.')[0]}.${'x'.repeat(43)}`,
            },
          }).expect(400);
          assert.deepEqual(await counts(), before);
          const claim = proofs.decode(candidate.selectionToken),
            key = randomUUID();
          await database.adminPool.query(
            `ALTER TABLE product_gotit.item_examples ADD CONSTRAINT capture_example_failure CHECK (example_text <> 'They charge a small fee.') NOT VALID`,
          );
          try {
            await save(input, key).expect(503);
            assert.deepEqual(await counts(), before);
          } finally {
            await database.adminPool.query(
              'ALTER TABLE product_gotit.item_examples DROP CONSTRAINT capture_example_failure',
            );
          }
          const trace = await database.adminPool.query(
            'SELECT learning_item_id FROM product_gotit.enrichment_runs WHERE id=$1',
            [claim.facts.runId],
          );
          assert.equal(trace.rows[0].learning_item_id, null);
          await save(input, key).expect(201);
        },
      );
      await t.test(
        'capture validation/authentication and logs contain no submitted text, context, tickets or credentials',
        async () => {
          const privateText = `private-text-${randomUUID()}`,
            privateSentence = `private-sentence-${randomUUID()}`;
          const input = {
            ...body(privateText),
            context: { selectedText: privateText, sentenceText: privateSentence },
          };
          await request(app)
            .post('/api/v1/captures')
            .set('Authorization', 'Bearer user-0')
            .send(input)
            .expect(400);
          await save({ ...input, clientEventId: randomUUID() }).expect(400);
          await detail('invalid').expect(400);
          await save({
            ...input,
            senseDecision: { mode: 'merge', learningItemId: randomUUID() },
          }).expect(404);
          await save(input).expect(201);
          await save(input).expect(409);
          await request(app)
            .post('/api/v1/captures/preview')
            .send({ selectedText: privateText })
            .expect(401);
          assert.equal(logs.includes(privateText), false);
          assert.equal(logs.includes(privateSentence), false);
          assert.equal(logs.includes('private=context'), false);
          assert.equal(logs.includes('Bearer user-'), false);
          assert.equal(logs.includes('selectionToken'), false);
        },
      );
    } finally {
      await database.dispose();
    }
  },
);
