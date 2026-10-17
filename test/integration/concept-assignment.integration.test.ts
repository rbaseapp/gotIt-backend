import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../helpers/postgres.js';
import {
  ConceptAssignmentService,
  conceptSearchText,
} from '../../src/modules/concepts/concept-assignment.service.js';
import { ConceptImagesService } from '../../src/modules/concepts/concept-images.service.js';
import {
  conceptDescriptorSchema,
  type ConceptAssignmentProvider,
  type ConceptAssignmentInput,
  type ConceptDescriptor,
  type ConceptCandidate,
} from '../../src/modules/concepts/concept-assignment.provider.js';
import { CaptureService } from '../../src/modules/capture/capture.service.js';
import { CaptureRepository } from '../../src/modules/capture/capture.repository.js';
import { saveSchema } from '../../src/modules/capture/capture.validation.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import { ProductAdminService, type AdminActor } from '../../src/modules/admin/admin.service.js';
import { wordListSchema } from '../../src/modules/admin/admin.words.js';
import { DEFAULT_LEARNING_POLICY } from '../../src/modules/learning/learning.policy.js';
import { WordPackStudyService } from '../../src/modules/word-packs/word-pack-study.service.js';
import type { WordPackRepository } from '../../src/modules/word-packs/word-packs.repository.js';
import { AppError } from '../../src/shared/errors/app-error.js';
import { withTransaction } from '../../src/shared/database/transaction.js';
import { ensureWordImageConcept } from '../../src/modules/concepts/automatic-word-images.js';

test(
  'automatic concept assignment is durable, semantic, revision-safe and shared across languages',
  { timeout: 150000 },
  async (t) => {
    const db = await createTestDatabase();
    try {
      const scope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
      const other = { applicationId: randomUUID(), applicationUserId: randomUUID() };
      for (const [i, s] of [scope, other].entries()) {
        await db.adminPool.query(
          `INSERT INTO core.applications(id,key,name) VALUES($1,$2,'Assignment fixture')`,
          [s.applicationId, `assign-${i}`],
        );
        await db.adminPool.query(
          `INSERT INTO core.application_users(application_id,id,email) VALUES($1,$2,$3)`,
          [s.applicationId, s.applicationUserId, `assignment-${i}@example.test`],
        );
      }
      const profiles = new ProfileService(new ProfileRepository(db.runtimePool));
      await profiles.getProfile(scope);
      await profiles.getProfile(other);
      const captures = new CaptureService(new CaptureRepository(db.runtimePool), profiles);
      const capture = async (
        source: string,
        translation: string,
        sourceLang = 'en',
        targetLang = 'he',
        owner = scope,
        context: string | null = null,
      ) => {
        const input = saveSchema.parse({
          item: {
            sourceText: source,
            sourceLanguageCode: sourceLang,
            translationLanguageCode: targetLang,
            itemType: 'word',
          },
          translation: { text: translation },
          context: { selectedText: source, sentenceText: context },
          senseDecision: { mode: 'create_new_sense' },
        });
        const key = randomUUID(),
          receipt = await captures.save(owner, key, input);
        return { id: receipt.capture.learningItemId, receipt, key, input, owner };
      };
      const insertConcept = async (
        key: string,
        definition: string,
        forms: [string, string][],
        owner = scope,
      ) => {
        const id = randomUUID();
        await db.runtimePool.query(
          `INSERT INTO product_gotit.lexical_concepts(application_id,id,key,title,definition,visual_description) VALUES($1,$2,$3,$3,$4,'A reusable isolated illustration')`,
          [owner.applicationId, id, key, definition],
        );
        for (const [language, text] of forms)
          await db.runtimePool.query(
            `INSERT INTO product_gotit.concept_expressions(application_id,concept_id,language_code,expression,normalized_text) VALUES($1,$2,$3,$4,$5)`,
            [owner.applicationId, id, language, text, text.normalize('NFKC').toLowerCase()],
          );
        return id;
      };
      const findId = await insertConcept('find-discover', 'To discover or locate something.', [
        ['en', 'find'],
        ['he', 'למצוא'],
      ]);
      const find = conceptDescriptorSchema.parse({
        key: 'find-discover',
        lemma: 'find',
        synonyms: ['discover', 'locate'],
        partOfSpeech: 'verb',
        definition: 'To discover or locate something.',
        visualDescription: 'One person finding an object.',
        sourceLemma: 'وجد',
        translationLemma: 'למצוא',
      });
      const pear = conceptDescriptorSchema.parse({
        key: 'pear-fruit',
        lemma: 'pear',
        synonyms: [],
        partOfSpeech: 'noun',
        definition: 'The edible pear fruit.',
        visualDescription: 'One green pear fruit.',
        sourceLemma: 'pear',
        translationLemma: 'אגס',
      });
      let describes = 0,
        choices = 0,
        failChoose = false;
      let beforeDescribe: ((input: ConceptAssignmentInput) => Promise<void>) | undefined;
      let beforeChoose:
        | ((input: ConceptAssignmentInput, candidates: ConceptCandidate[]) => Promise<void>)
        | undefined;
      const provider: ConceptAssignmentProvider = {
        id: 'semantic-fixture',
        describe: async (input) => {
          describes++;
          await beforeDescribe?.(input);
          return input.sourceText.includes('bank')
            ? {
                ...find,
                key: 'bank-financial',
                lemma: 'bank',
                synonyms: [],
                partOfSpeech: 'noun',
                definition: 'A financial institution.',
                sourceLemma: 'bank',
                translationLemma: 'בנק',
              }
            : /pear|poire/iu.test(input.sourceText)
              ? {
                  ...pear,
                  sourceLemma: input.sourceLanguageCode === 'fr' ? 'poire' : 'pear',
                  translationLemma: input.translationLanguageCode === 'fr' ? 'poire' : 'אגס',
                }
              : find;
        },
        choose: async (input, descriptor, candidates) => {
          choices++;
          await beforeChoose?.(input, candidates);
          if (failChoose) throw new Error('Upstream body contains private credentials');
          return candidates.find((c) => c.definition === descriptor.definition)?.id ?? null;
        },
      };
      const worker = new ConceptAssignmentService(db.runtimePool, provider);
      const bind = async (id: string, owner = scope) =>
        (
          await db.runtimePool.query(
            `SELECT * FROM product_gotit.learning_item_concepts WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3`,
            [owner.applicationId, owner.applicationUserId, id],
          )
        ).rows[0];
      const job = async (id: string) =>
        (
          await db.runtimePool.query(
            `SELECT * FROM product_gotit.concept_assignment_jobs WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3`,
            [scope.applicationId, scope.applicationUserId, id],
          )
        ).rows[0];
      const actor: AdminActor = { ...scope, token: 'fixture', requestId: randomUUID() };
      const admin = new ProductAdminService(
        db.runtimePool,
        {
          getAdminAccess: async () => ({
            ...scope,
            mfaEnrolled: true,
            mfaVerified: true,
            permissions: ['content.write'],
          }),
          getAdminUser: async () => ({
            id: scope.applicationUserId,
            status: 'active',
            email: 'fixture@example.test',
            emailVerified: true,
          }),
        },
        profiles,
        DEFAULT_LEARNING_POLICY,
      );

      await t.test(
        'وَجَدَ attaches to existing find despite vowels and inflected Hebrew; capture replay does not requeue',
        async () => {
          const word = await capture('وَجَدَ', 'מָצָא', 'ar', 'he', scope, 'وَجَدَ الكتاب.');
          assert.equal((await job(word.id)).status, 'pending');
          await worker.assign(scope.applicationId, scope.applicationUserId, word.id);
          await db.runtimePool.query(
            `UPDATE product_gotit.learning_items SET part_of_speech='verb' WHERE id=$1`,
            [word.id],
          );
          assert.equal(
            (await job(word.id)).status,
            'pending',
            'corrected part of speech must also be reconsidered',
          );
          assert.equal(
            await worker.assign(scope.applicationId, scope.applicationUserId, word.id),
            true,
          );
          assert.equal((await bind(word.id)).concept_id, findId);
          const aliases = (
            await db.runtimePool.query(
              `SELECT expression,search_text FROM product_gotit.concept_expressions WHERE concept_id=$1 AND language_code='ar'`,
              [findId],
            )
          ).rows;
          assert.ok(aliases.some((e) => e.expression === 'وَجَدَ' && e.search_text === 'وجد'));
          assert.equal((await job(word.id)).status, 'completed');
          const oldCalls = describes + choices,
            oldGeneration = (await job(word.id)).generation;
          const replay = await captures.save(scope, word.key, word.input);
          assert.deepEqual(replay.capture, word.receipt.capture);
          assert.equal((await job(word.id)).generation, oldGeneration);
          assert.equal(
            await worker.assign(scope.applicationId, scope.applicationUserId, word.id),
            false,
          );
          assert.equal(describes + choices, oldCalls);
          const visible = await admin.words.list(actor, wordListSchema.parse({}), word.id);
          assert.equal(visible.data.conceptId, findId);
          assert.equal(visible.data.conceptAssignmentStatus, 'completed');
          const imageTarget = await withTransaction(db.runtimePool, async (tx) => {
            const savedWord = (
              await tx.query(
                `SELECT li.*,tr.translation_text FROM product_gotit.learning_items li
                JOIN product_gotit.item_translations tr ON tr.application_id=li.application_id AND tr.application_user_id=li.application_user_id AND tr.learning_item_id=li.id AND tr.is_current AND tr.is_primary
                WHERE li.application_id=$1 AND li.application_user_id=$2 AND li.id=$3`,
                [scope.applicationId, scope.applicationUserId, word.id],
              )
            ).rows[0]!;
            return ensureWordImageConcept(tx, scope.applicationId, savedWord);
          });
          assert.equal(imageTarget.id, findId, 'card replacement must use the assigned meaning');
          const imageService = new ConceptImagesService(
            db.runtimePool,
            {
              id: 'image',
              generate: async () => ({
                data: Buffer.from('same-image'),
                contentType: 'image/png',
                kind: 'generated',
                provider: 'fixture',
                sourceUrl: null,
                creator: null,
              }),
            },
            true,
          );
          const input = {
            scope,
            learningItemId: word.id,
            sourceText: 'وَجَدَ',
            translationText: 'מָצָא',
            sourceLanguageCode: 'ar',
            translationLanguageCode: 'he',
            context: null,
          };
          assert.equal(await imageService.pending(input), false);
          const concept = (await imageService.resolve(input))!;
          assert.equal(concept.id, findId);
          const image = await imageService.image(concept, input, true);
          assert.equal(
            image?.url,
            (
              await imageService.image(
                concept,
                {
                  ...input,
                  sourceText: 'find',
                  sourceLanguageCode: 'en',
                  translationText: 'למצוא',
                },
                false,
              )
            )?.url,
          );
        },
      );
      await t.test(
        'concurrent new-language words create one new meaning and all future words reuse it',
        async () => {
          const a = await capture('pear', 'אגס'),
            b = await capture('poire', 'אגס', 'fr');
          let waiters = 0,
            release: () => void = () => {};
          const barrier = new Promise<void>((resolve) => (release = resolve));
          beforeDescribe = async (input) => {
            if (/pear|poire/u.test(input.sourceText)) {
              waiters++;
              if (waiters === 2) release();
              await barrier;
            }
          };
          assert.deepEqual(
            await Promise.all([
              worker.assign(scope.applicationId, scope.applicationUserId, a.id),
              worker.assign(scope.applicationId, scope.applicationUserId, b.id),
            ]),
            [true, true],
          );
          beforeDescribe = undefined;
          assert.equal((await bind(a.id)).concept_id, (await bind(b.id)).concept_id);
          assert.equal(
            (
              await db.runtimePool.query(
                `SELECT count(*)::int n FROM product_gotit.lexical_concepts WHERE application_id=$1 AND canonical_lemma='pear'`,
                [scope.applicationId],
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (
              await db.runtimePool.query(
                `SELECT origin FROM product_gotit.lexical_concepts WHERE id=$1`,
                [(await bind(a.id)).concept_id],
              )
            ).rows[0].origin,
            'ai',
          );
        },
      );
      await t.test(
        'AI disambiguates homonyms; it cannot select a foreign or invented concept ID',
        async () => {
          const financial = await insertConcept('bank-financial', 'A financial institution.', [
            ['en', 'bank'],
            ['he', 'בנק'],
          ]);
          const river = await insertConcept('bank-river', 'The land at the edge of a river.', [
            ['en', 'bank'],
            ['he', 'גדה'],
          ]);
          const word = await capture(
            'bank',
            'בנק',
            'en',
            'he',
            scope,
            'I deposited money at the bank.',
          );
          beforeChoose = async (_input, candidates) => {
            assert.ok(candidates.some((c) => c.id === financial));
            assert.ok(candidates.some((c) => c.id === river));
          };
          assert.equal(
            await worker.assign(scope.applicationId, scope.applicationUserId, word.id),
            true,
          );
          beforeChoose = undefined;
          assert.equal((await bind(word.id)).concept_id, financial);
          const invalid = await capture('bank', 'בנק');
          const evil = new ConceptAssignmentService(db.runtimePool, {
            ...provider,
            choose: async () => randomUUID(),
          });
          assert.equal(
            await evil.assign(scope.applicationId, scope.applicationUserId, invalid.id),
            false,
          );
          assert.equal((await job(invalid.id)).last_error, 'CONCEPT_AI_INVALID_CHOICE');
          assert.equal(await bind(invalid.id), undefined);
        },
      );
      await t.test(
        'provider failure leaves a durable retry, reuses the descriptor, and never reports fabricated success',
        async () => {
          const word = await capture('وجد', 'למצוא', 'ar');
          const initialDescribes = describes;
          failChoose = true;
          assert.equal(
            await worker.assign(scope.applicationId, scope.applicationUserId, word.id),
            false,
          );
          failChoose = false;
          const failed = await job(word.id);
          assert.equal(failed.status, 'pending');
          assert.ok(failed.descriptor);
          assert.equal(failed.last_error, 'CONCEPT_AI_UNAVAILABLE');
          assert.doesNotMatch(JSON.stringify(failed), /private credentials/);
          assert.equal(await bind(word.id), undefined);
          await db.runtimePool.query(
            `UPDATE product_gotit.concept_assignment_jobs SET next_attempt_at=now() WHERE learning_item_id=$1`,
            [word.id],
          );
          assert.equal(
            await worker.assign(scope.applicationId, scope.applicationUserId, word.id),
            true,
          );
          assert.equal(describes, initialDescribes + 1);
          assert.equal((await bind(word.id)).concept_id, findId);
        },
      );
      await t.test(
        'one persisted claim prevents duplicate AI work; expired claims recover after restart',
        async () => {
          const word = await capture('وَجَدَ', 'למצוא', 'ar');
          let release: () => void = () => {},
            started: () => void = () => {};
          const ready = new Promise<void>((resolve) => (started = resolve)),
            blocked = new Promise<void>((resolve) => (release = resolve));
          beforeDescribe = async () => {
            started();
            await blocked;
          };
          const first = worker.assign(scope.applicationId, scope.applicationUserId, word.id);
          await ready;
          assert.equal(
            await new ConceptAssignmentService(db.runtimePool, provider).assign(
              scope.applicationId,
              scope.applicationUserId,
              word.id,
            ),
            false,
          );
          release();
          assert.equal(await first, true);
          beforeDescribe = undefined;
          const recover = await capture('وجد', 'למצוא', 'ar');
          await db.runtimePool.query(
            `UPDATE product_gotit.concept_assignment_jobs SET status='processing',claim_id=$2,claim_until=now()-interval '1 minute' WHERE learning_item_id=$1`,
            [recover.id, randomUUID()],
          );
          assert.equal(
            await new ConceptAssignmentService(db.runtimePool, provider).assign(
              scope.applicationId,
              scope.applicationUserId,
              recover.id,
            ),
            true,
          );
        },
      );
      await t.test(
        'word edits and deletion invalidate in-flight decisions and queue the current revision only',
        async () => {
          const word = await capture('وجد', 'למצוא', 'ar');
          beforeChoose = async () => {
            await db.runtimePool.query(
              `UPDATE product_gotit.learning_items SET source_text='وَجَدَ',normalized_source_text='وَجَدَ',learning_revision=learning_revision+1 WHERE id=$1`,
              [word.id],
            );
          };
          assert.equal(
            await worker.assign(scope.applicationId, scope.applicationUserId, word.id),
            false,
          );
          beforeChoose = undefined;
          assert.equal(await bind(word.id), undefined);
          assert.equal((await job(word.id)).learning_revision, 2);
          assert.equal(
            await worker.assign(scope.applicationId, scope.applicationUserId, word.id),
            true,
          );
          assert.equal((await bind(word.id)).learning_revision, 2);
          await db.runtimePool.query(
            `UPDATE product_gotit.learning_items SET deleted_at=now() WHERE id=$1`,
            [word.id],
          );
          assert.equal(await job(word.id), undefined);
          assert.equal(
            await worker.assign(scope.applicationId, scope.applicationUserId, word.id),
            false,
          );
          await db.runtimePool.query(
            `UPDATE product_gotit.learning_items SET deleted_at=NULL WHERE id=$1`,
            [word.id],
          );
          assert.equal((await job(word.id)).status, 'pending');
        },
      );
      await t.test(
        'ordinary translation edits requeue even when learning revision does not change; learning evidence stays independent',
        async () => {
          const word = await capture('وجد', 'למצוא', 'ar');
          await worker.assign(scope.applicationId, scope.applicationUserId, word.id);
          const old = (await bind(word.id)).job_generation;
          await db.runtimePool.query(
            `UPDATE product_gotit.item_translations SET translation_text='לִמְצֹא',normalized_text='לִמְצֹא' WHERE learning_item_id=$1 AND is_primary`,
            [word.id],
          );
          assert.ok((await job(word.id)).generation > old);
          assert.equal(
            await new ConceptImagesService(db.runtimePool, undefined, true).pending({
              scope,
              learningItemId: word.id,
              sourceText: 'وجد',
              sourceLanguageCode: 'ar',
              translationText: 'לִמְצֹא',
              translationLanguageCode: 'he',
              context: null,
            }),
            true,
          );
          await worker.assign(scope.applicationId, scope.applicationUserId, word.id);
          const item = (
            await db.runtimePool.query(
              `SELECT learning_revision,overall_mastery_score,learning_status FROM product_gotit.learning_items WHERE id=$1`,
              [word.id],
            )
          ).rows[0];
          assert.equal(item.learning_revision, 1);
          assert.equal(Number(item.overall_mastery_score), 0);
          assert.equal(item.learning_status, 'new');
          assert.equal(
            (
              await db.runtimePool.query(
                `SELECT count(*)::int n FROM product_gotit.practice_attempts`,
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        'meaning edits requeue linked words; image-only revision changes preserve their bindings',
        async () => {
          const word = await capture('وجد', 'למצוא', 'ar');
          await worker.assign(scope.applicationId, scope.applicationUserId, word.id);
          await db.runtimePool.query(
            `UPDATE product_gotit.lexical_concepts SET image_revision=image_revision+1 WHERE id=$1`,
            [findId],
          );
          assert.equal((await job(word.id)).status, 'completed');
          await db.runtimePool.query(
            `UPDATE product_gotit.lexical_concepts SET definition='Discover or locate a previously unknown thing.' WHERE id=$1`,
            [findId],
          );
          assert.equal((await job(word.id)).status, 'pending');
          assert.ok(
            (
              await db.runtimePool.query(
                `SELECT meaning_revision FROM product_gotit.lexical_concepts WHERE id=$1`,
                [findId],
              )
            ).rows[0].meaning_revision > (await bind(word.id)).meaning_revision,
          );
        },
      );
      await t.test(
        'all creation paths enqueue atomically; SQL/JS mark handling agree and application scope is preserved',
        async () => {
          const client = await db.runtimePool.connect();
          const id = randomUUID();
          try {
            await client.query('BEGIN');
            await client.query(
              `INSERT INTO product_gotit.learning_items(application_id,application_user_id,id,source_text,normalized_source_text,source_language_code,translation_language_code,item_type) VALUES($1,$2,$3,'new','new','en','he','word')`,
              [scope.applicationId, scope.applicationUserId, id],
            );
            assert.equal(
              (
                await client.query(
                  `SELECT count(*)::int n FROM product_gotit.concept_assignment_jobs WHERE learning_item_id=$1`,
                  [id],
                )
              ).rows[0].n,
              1,
            );
            await client.query('ROLLBACK');
          } finally {
            client.release();
          }
          assert.equal(await job(id), undefined);
          for (const [lang, text] of [
            ['ar', 'وَجَدَ'],
            ['he', 'מָצָא'],
            ['fr', 'été'],
          ])
            assert.equal(
              (
                await db.runtimePool.query(
                  `SELECT product_gotit.concept_search_text($1,$2) value`,
                  [lang, text],
                )
              ).rows[0].value,
              conceptSearchText(lang!, text!),
            );
          const foreign = await capture('pear', 'אגס', 'en', 'he', other);
          assert.equal(
            await worker.assign(scope.applicationId, scope.applicationUserId, foreign.id),
            false,
          );
          assert.equal(
            await worker.assign(other.applicationId, other.applicationUserId, foreign.id),
            true,
          );
          assert.notEqual((await bind(foreign.id, other)).concept_id, findId);
          const noProvider = new ConceptAssignmentService(db.runtimePool);
          assert.deepEqual(await noProvider.run(), { processed: 0 });
        },
      );
      await t.test(
        'daily quota exhaustion respects the server retry window without inventing a binding',
        async () => {
          const word = await capture('وجد', 'למצוא', 'ar');
          const limited = new ConceptAssignmentService(db.runtimePool, {
            ...provider,
            describe: async () => {
              throw new AppError(429, 'AI_DAILY_LIMIT_REACHED', 'limit', { retryAfter: 7200 });
            },
          });
          assert.equal(
            await limited.assign(scope.applicationId, scope.applicationUserId, word.id),
            false,
          );
          const pending = await job(word.id);
          assert.equal(pending.last_error, 'CONCEPT_DAILY_LIMIT_REACHED');
          assert.ok(new Date(pending.next_attempt_at).getTime() > Date.now() + 7100_000);
          assert.equal(await bind(word.id), undefined);
        },
      );
      await t.test(
        'new captures overtake backfill and pending semantics never generate a duplicate lexical image',
        async () => {
          await db.runtimePool.query(
            `UPDATE product_gotit.concept_assignment_jobs SET next_attempt_at=now()+interval '1 hour'`,
          );
          const historical = await capture('pear', 'אגס'),
            fresh = await capture('poire', 'אגס', 'fr');
          await db.runtimePool.query(
            `UPDATE product_gotit.concept_assignment_jobs SET priority=0,next_attempt_at=now()-interval '1 day' WHERE learning_item_id=$1`,
            [historical.id],
          );
          assert.deepEqual(await worker.run(1), { processed: 1 });
          assert.equal((await job(fresh.id)).status, 'completed');
          assert.equal((await job(historical.id)).status, 'pending');
          const packs = {
            detail: async () => ({
              pack: { track: { sourceLanguageCode: 'en', translationLanguageCode: 'he' } },
              entries: [
                {
                  id: 'entry',
                  learningItemId: historical.id,
                  sourceText: 'pear',
                  translationText: 'אגס',
                  partOfSpeech: 'noun',
                  exampleText: null,
                },
              ],
            }),
            image: async () => {
              assert.fail('pending meaning must not use a stale lexical image');
            },
          } as unknown as WordPackRepository;
          const study = new WordPackStudyService(
            db.runtimePool,
            packs,
            {
              id: 'must-not-generate',
              generate: async () => {
                assert.fail('pending meaning must not generate a per-language image');
              },
            },
            undefined,
            true,
          );
          assert.deepEqual(await study.image(scope, 'pack', 'entry'), { image: null });
          assert.deepEqual(await study.cachedImage(scope, 'pack', 'entry'), { image: null });
          assert.deepEqual(await worker.run(1), { processed: 1 });
          assert.equal((await job(historical.id)).status, 'completed');
        },
      );
      await t.test(
        'name automatically extends an existing automatic pair across scripts, marks and regional tags',
        async () => {
          const english = await capture('name', 'שם');
          const nameId = await withTransaction(db.runtimePool, async (tx) => {
            const row = (
              await tx.query(`SELECT * FROM product_gotit.learning_items WHERE id=$1`, [english.id])
            ).rows[0]!;
            return (
              await ensureWordImageConcept(tx, scope.applicationId, {
                ...row,
                translation_text: 'שם',
              })
            ).id;
          });
          const languagePairs = [
            ['ar', 'إسم', 'he', 'שֵׁם'],
            ['fr', 'nom', 'de', 'Name'],
            ['es', 'nombre', 'ru', 'имя'],
            ['zh', '名字', 'ja', '名前'],
            ['hi', 'नाम', 'tr', 'isim'],
            ['ru', 'имя', 'fr', 'nom'],
            ['yi', 'נאָמען', 'he', 'שם'],
            ['en-US', 'name', 'fr-CA', 'nom'],
          ];
          const semantic = new ConceptAssignmentService(db.runtimePool, {
            id: 'multilingual-name-fixture',
            describe: async (input) => ({
              ...pear,
              key: 'name-designation',
              lemma: 'name',
              synonyms: ['designation'],
              definition: 'A word by which a person or thing is known.',
              sourceLemma: input.sourceText,
              translationLemma: input.translationText,
            }),
            choose: async (_input, _descriptor, candidates) => {
              assert.ok(
                candidates.some((c) => c.id === nameId),
                'English meaning pivot recalls the automatic concept without a shared input language',
              );
              return nameId;
            },
          });
          for (const [sl, st, tl, tt] of [['en', 'name', 'he', 'שם'], ...languagePairs]) {
            const word = sl === 'en' ? english : await capture(st!, tt!, sl!, tl!);
            const before = (
              await db.runtimePool.query(
                `SELECT learning_revision,overall_mastery_score,review_stage FROM product_gotit.learning_items WHERE id=$1`,
                [word.id],
              )
            ).rows[0];
            assert.equal(
              await semantic.assign(scope.applicationId, scope.applicationUserId, word.id),
              true,
            );
            assert.equal((await bind(word.id)).concept_id, nameId);
            assert.equal(
              (await admin.words.list(actor, wordListSchema.parse({}), word.id)).data.conceptId,
              nameId,
            );
            assert.deepEqual(
              (
                await db.runtimePool.query(
                  `SELECT learning_revision,overall_mastery_score,review_stage FROM product_gotit.learning_items WHERE id=$1`,
                  [word.id],
                )
              ).rows[0],
              before,
            );
          }
          const expressions = (
            await db.runtimePool.query(
              `SELECT language_code,expression FROM product_gotit.concept_expressions WHERE application_id=$1 AND concept_id=$2`,
              [scope.applicationId, nameId],
            )
          ).rows;
          for (const [sl, st, tl, tt] of languagePairs) {
            assert.ok(expressions.some((e) => e.language_code === sl && e.expression === st));
            assert.ok(expressions.some((e) => e.language_code === tl && e.expression === tt));
          }
        },
      );
      await t.test(
        'backfill quota defers only the exhausted owner and workload while fresh words continue',
        async () => {
          await db.runtimePool.query(
            `UPDATE product_gotit.concept_assignment_jobs SET next_attempt_at=now()+interval '1 hour' WHERE status<>'completed'`,
          );
          const old = await capture('pear', 'אגס'),
            otherOld = await capture('poire', 'אגס', 'fr'),
            fresh = await capture('pear', 'אגס'),
            foreign = await capture('pear', 'אגס', 'en', 'he', other);
          await db.runtimePool.query(
            `UPDATE product_gotit.concept_assignment_jobs SET priority=0 WHERE learning_item_id=ANY($1::uuid[])`,
            [[old.id, otherOld.id, foreign.id]],
          );
          const limited = new ConceptAssignmentService(db.runtimePool, {
            ...provider,
            describe: async (input) => {
              if (
                input.workload === 'backfill' &&
                input.scope.applicationId === scope.applicationId
              )
                throw new AppError(429, 'AI_DAILY_LIMIT_REACHED', 'limit', { retryAfter: 7200 });
              return provider.describe(input);
            },
          });
          assert.equal(
            await limited.assign(scope.applicationId, scope.applicationUserId, old.id),
            false,
          );
          assert.equal((await job(otherOld.id)).last_error, 'CONCEPT_DAILY_LIMIT_REACHED');
          assert.equal(
            (await job(otherOld.id)).attempts,
            0,
            'do not burn attempts on every row in an exhausted queue',
          );
          assert.equal(
            await limited.assign(scope.applicationId, scope.applicationUserId, fresh.id),
            true,
          );
          assert.equal(
            await limited.assign(other.applicationId, other.applicationUserId, foreign.id),
            true,
          );
          assert.equal((await job(old.id)).status, 'pending');
        },
      );
      await t.test(
        'the new migration guards resolved work and backfills historical words after a safe disposable rollback',
        async () => {
          await db.migrate('down'); // Workload migration is deliberately data-preserving.
          const [historical] = (
            await db.runtimePool.query(
              `SELECT * FROM product_gotit.concept_assignment_jobs WHERE priority=0 AND status='pending' LIMIT 1`,
            )
          ).rows;
          await db.runtimePool.query(
            `UPDATE product_gotit.concept_assignment_jobs SET last_error='CONCEPT_DAILY_LIMIT_REACHED',next_attempt_at=now()+interval '1 day' WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3`,
            [
              historical.application_id,
              historical.application_user_id,
              historical.learning_item_id,
            ],
          );
          await db.migrate('up');
          const released = (
            await db.runtimePool.query(
              `SELECT last_error,next_attempt_at,descriptor FROM product_gotit.concept_assignment_jobs WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3`,
              [
                historical.application_id,
                historical.application_user_id,
                historical.learning_item_id,
              ],
            )
          ).rows[0];
          assert.equal(released.last_error, null);
          assert.ok(new Date(released.next_attempt_at).getTime() <= Date.now());
          assert.deepEqual(released.descriptor, historical.descriptor);
          await db.migrate('down');
          await assert.rejects(db.migrate('down'));
          await db.runtimePool.query(`DELETE FROM product_gotit.learning_item_concepts`);
          await db.runtimePool.query(
            `UPDATE product_gotit.concept_assignment_jobs SET attempts=0,status='pending',claim_id=NULL,claim_until=NULL`,
          );
          await db.migrate('down');
          await db.migrate('up');
          const count = (
            await db.runtimePool.query(
              `SELECT count(*)::int n FROM product_gotit.concept_assignment_jobs`,
            )
          ).rows[0].n;
          assert.equal(
            count,
            (
              await db.runtimePool.query(
                `SELECT count(*)::int n FROM product_gotit.learning_items WHERE deleted_at IS NULL`,
              )
            ).rows[0].n,
          );
        },
      );
    } finally {
      await db.dispose();
    }
  },
);
