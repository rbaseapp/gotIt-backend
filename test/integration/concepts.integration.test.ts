import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { WordPackRepository } from '../../src/modules/word-packs/word-packs.repository.js';
import { createTestDatabase } from '../helpers/postgres.js';
import { ProductAdminService, type AdminActor } from '../../src/modules/admin/admin.service.js';
import { conceptSaveSchema } from '../../src/modules/concepts/concepts.schema.js';
import { ConceptImagesService } from '../../src/modules/concepts/concept-images.service.js';
import { listSchema } from '../../src/modules/admin/admin.schemas.js';
import { DEFAULT_LEARNING_POLICY } from '../../src/modules/learning/learning.policy.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { WordPackStudyService } from '../../src/modules/word-packs/word-pack-study.service.js';
import { PracticeService } from '../../src/modules/practice/practice.service.js';
import { sessionSchema } from '../../src/modules/practice/practice.validation.js';
import { CaptureService } from '../../src/modules/capture/capture.service.js';
import { CaptureRepository } from '../../src/modules/capture/capture.repository.js';
import { saveSchema } from '../../src/modules/capture/capture.validation.js';
import { SelectionProofs } from '../../src/modules/enrichment/selection-proof.js';
import { EnrichmentRegistry } from '../../src/modules/enrichment/enrichment.registry.js';

test(
  'multilingual concepts share one persistent image and preserve meaning, scope and admin controls',
  { timeout: 150000 },
  async (t) => {
    const db = await createTestDatabase();
    try {
      const actor: AdminActor = {
        applicationId: randomUUID(),
        applicationUserId: randomUUID(),
        token: 'fixture',
        requestId: randomUUID(),
      };
      const other = { ...actor, applicationId: randomUUID(), applicationUserId: randomUUID() };
      for (const [index, scope] of [actor, other].entries()) {
        await db.adminPool.query(
          `INSERT INTO core.applications(id,key,name) VALUES($1,$2,'Concept test')`,
          [scope.applicationId, `concept-${index}`],
        );
        await db.adminPool.query(
          `INSERT INTO core.application_users(application_id,id,email) VALUES($1,$2,$3)`,
          [scope.applicationId, scope.applicationUserId, `concept-${index}@example.test`],
        );
      }
      const profiles = new ProfileService(new ProfileRepository(db.runtimePool));
      await profiles.getProfile(actor);
      await profiles.getProfile(other);
      let allowed = true,
        mfa = true,
        generations = 0;
      let release: (() => void) | undefined;
      const provider = {
        id: 'concept-fixture',
        generate: async (input: any) => {
          generations++;
          assert.equal(input.context, null, 'private source context never enters shared media');
          assert.match(input.visual.visualDescription, /apple|fruit/);
          assert.deepEqual(input.visual.searchQueries, ['apple fruit isolated']);
          assert.deepEqual(input.visual.includeTags, ['apple fruit']);
          if (release === undefined && generations === 2)
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          return {
            data: Buffer.from('concept-image'),
            contentType: 'image/png' as const,
            kind: 'generated' as const,
            provider: 'fixture',
            sourceUrl: null,
            creator: null,
          };
        },
      };
      const core = {
        getAdminAccess: async () => ({
          applicationId: actor.applicationId,
          applicationUserId: actor.applicationUserId,
          mfaEnrolled: true,
          mfaVerified: mfa,
          permissions: allowed ? ['content.write' as const] : [],
        }),
        getAdminUser: async () => ({
          id: actor.applicationUserId,
          status: 'active' as const,
          email: 'fixture@example.test',
          emailVerified: true,
        }),
      };
      const admin = new ProductAdminService(
        db.runtimePool,
        core,
        profiles,
        DEFAULT_LEARNING_POLICY,
        undefined,
        undefined,
        provider,
      );
      const document = {
        key: 'apple-fruit',
        title: 'Apple fruit / תפוח',
        definition: 'The edible apple fruit, not the company',
        visualDescription: 'One red apple fruit without text',
        stockSearchQuery: 'apple fruit isolated',
        status: 'active' as const,
        expressions: [
          { languageCode: 'en', text: 'apple' },
          { languageCode: 'he', text: 'תפוח' },
          { languageCode: 'ar', text: 'تفاحة' },
          { languageCode: 'yi', text: 'עפּל' },
        ],
      };
      const command = (revision: number | null, doc = document, resetImage = false) =>
        conceptSaveSchema.parse({
          operationId: randomUUID(),
          reason: 'Reviewed exact lexical meaning',
          expectedRevision: revision,
          document: doc,
          resetImage,
        });
      const create = command(null);
      const saved = await admin.concepts.save(actor, null, create);
      const id = String(saved.data.id);
      await t.test(
        'admin commands require permission and MFA, replay once and reject changed payloads',
        async () => {
          assert.deepEqual(await admin.concepts.save(actor, null, create), saved);
          await assert.rejects(
            admin.concepts.save(actor, null, { ...create, reason: 'Different payload' }),
            { code: 'CONFLICT' },
          );
          allowed = false;
          await assert.rejects(admin.concepts.save(actor, id, command(0)), {
            code: 'PERMISSION_REQUIRED',
          });
          allowed = true;
          mfa = false;
          await assert.rejects(admin.concepts.save(actor, id, command(0)), {
            code: 'ADMIN_MFA_REQUIRED',
          });
          mfa = true;
          await assert.rejects(admin.concepts.save(actor, id, command(9)), { code: 'CONFLICT' });
          assert.equal(
            (
              await db.adminPool.query(
                `SELECT count(*)::int n FROM product_gotit.admin_audit_events WHERE resource='concepts'`,
              )
            ).rows[0].n,
            1,
          );
          assert.equal(
            (await admin.concepts.list(actor, listSchema.parse({ q: 'تفاحة' }))).total,
            1,
          );
          const foreign = new ProductAdminService(
            db.runtimePool,
            {
              ...core,
              getAdminAccess: async () => ({
                ...(await core.getAdminAccess()),
                applicationId: other.applicationId,
                applicationUserId: other.applicationUserId,
              }),
            },
            profiles,
            DEFAULT_LEARNING_POLICY,
          );
          await assert.rejects(foreign.concepts.list(other, listSchema.parse({}), id), {
            code: 'NOT_FOUND',
          });
          await assert.rejects(foreign.concepts.save(other, id, command(0)), { code: 'NOT_FOUND' });
        },
      );
      const input = (
        sourceText = 'apple',
        sourceLanguageCode = 'en',
        translationText = 'תפוח',
        translationLanguageCode = 'he',
        scope = actor,
      ) => ({
        scope,
        sourceText,
        sourceLanguageCode,
        translationText,
        translationLanguageCode,
        context: 'private sentence must be discarded',
      });
      const images = new ConceptImagesService(db.runtimePool, provider);
      const concept = (await images.resolve(input()))!;
      assert.equal(concept.id, id);
      await t.test(
        'Arabic, English, Hebrew and Yiddish reuse the same bytes after service restart, even without a provider',
        async () => {
          const first = await images.image(concept, input(), true);
          assert.ok(first?.url);
          const restarted = new ConceptImagesService(db.runtimePool);
          for (const pair of [
            input('تفاحة', 'ar'),
            input('עפּל', 'yi'),
            input('תפוח', 'he', 'apple', 'en'),
          ]) {
            const match = (await restarted.resolve(pair))!;
            assert.equal(match.id, id);
            const image = await restarted.image(match, pair, true);
            assert.equal(image?.url, first.url);
            assert.equal(image?.alt, pair.sourceText);
          }
          assert.equal(generations, 1);
          assert.equal(
            await images.resolve(input('apple', 'en', 'אפל')),
            null,
            'company sense is not a fruit',
          );
          assert.equal(
            await images.resolve(input('apple', 'en', 'תפוח', 'he', other)),
            null,
            'other application cannot read this concept',
          );
        },
      );
      await t.test(
        'catalog GET and practice both reuse the same concept image without extra learning writes',
        async () => {
          const packs = {
            detail: async () => ({
              pack: { track: { sourceLanguageCode: 'ar', translationLanguageCode: 'he' } },
              entries: [
                {
                  id: 'entry',
                  sourceText: 'تفاحة',
                  translationText: 'תפוח',
                  partOfSpeech: 'noun',
                  exampleText: null,
                },
              ],
            }),
            image: async () => {
              assert.fail('concept image must take precedence over legacy cache');
            },
          } as unknown as WordPackRepository;
          const study = new WordPackStudyService(db.runtimePool, packs, provider);
          assert.ok((await study.cachedImage(actor, 'pack', 'entry')).image?.url);
          assert.equal((await study.image(actor, 'pack', 'entry')).image?.alt, 'تفاحة');
          assert.equal(
            (await db.adminPool.query(`SELECT count(*)::int n FROM product_gotit.learning_items`))
              .rows[0].n,
            0,
          );
          const capture = new CaptureService(
            new CaptureRepository(db.runtimePool),
            profiles,
            new EnrichmentRegistry(),
            new SelectionProofs(undefined),
          );
          const captured = await capture.save(
            actor,
            randomUUID(),
            saveSchema.parse({
              item: {
                sourceText: 'apple',
                sourceLanguageCode: 'en',
                translationLanguageCode: 'he',
                itemType: 'word',
              },
              translation: { text: 'תפוח' },
              context: { selectedText: 'apple' },
              senseDecision: { mode: 'auto' },
            }),
          );
          const itemId = captured.capture.learningItemId;
          const practice = new PracticeService(
            db.runtimePool,
            profiles,
            undefined,
            undefined,
            provider,
          );
          const session = await practice.createSession(
            actor,
            randomUUID(),
            sessionSchema.parse({ sessionType: 'flashcards', learningItemIds: [itemId] }),
          );
          const media = await practice.studyImage(actor, session.session.id, itemId);
          assert.equal(
            media.image?.url,
            (await study.cachedImage(actor, 'pack', 'entry')).image?.url,
          );
          assert.equal(generations, 1);
        },
      );
      await t.test('adding a language keeps the image; ambiguous senses never merge', async () => {
        const withFrench = {
          ...document,
          expressions: [...document.expressions, { languageCode: 'fr', text: 'pomme' }],
        };
        await admin.concepts.save(actor, id, command(0, withFrench));
        assert.equal(
          (await admin.concepts.list(actor, listSchema.parse({}), id)).data.imageRevision,
          1,
        );
        assert.equal((await images.resolve(input('pomme', 'fr')))?.id, id);
        const duplicate = await admin.concepts.save(
          actor,
          null,
          command(null, { ...document, key: 'apple-other' }),
        );
        assert.equal(
          await images.resolve(input()),
          null,
          'two candidate meanings must remain ambiguous',
        );
        await admin.concepts.save(
          actor,
          String(duplicate.data.id),
          command(0, { ...document, key: 'apple-other', status: 'disabled' as 'active' }),
        );
        assert.equal((await images.resolve(input()))?.id, id);
      });
      await t.test(
        'explicit reset changes image version; concurrent cross-language requests claim one generation',
        async () => {
          await admin.concepts.save(actor, id, command(1, document, true));
          const next = (await images.resolve(input()))!;
          assert.equal(next.image_revision, 2);
          assert.equal(await images.cached(next, 'apple'), null);
          const work = images.image(next, input(), true);
          for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 5));
          assert.ok(release);
          assert.equal(
            await new ConceptImagesService(db.runtimePool, provider).image(
              next,
              input('تفاحة', 'ar'),
              true,
            ),
            null,
          );
          assert.equal(generations, 2);
          release();
          await work;
          const generate = {
            operationId: randomUUID(),
            reason: 'Ensure shared image',
            expectedRevision: 2,
          };
          const a = await admin.concepts.generate(actor, id, generate),
            b = await admin.concepts.generate(actor, id, generate);
          assert.deepEqual(a, b);
          assert.equal(generations, 2);
          assert.equal(
            (await admin.concepts.list(actor, listSchema.parse({}), id)).data.hasImage,
            true,
          );
        },
      );
      await t.test(
        'failed claims retry and stale generation cannot publish after semantic edits',
        async () => {
          await admin.concepts.save(actor, id, command(2, document, true));
          const next = (await images.resolve(input()))!;
          const failure = new ConceptImagesService(db.runtimePool, {
            id: 'failed',
            generate: async () => null,
          });
          assert.equal(await failure.image(next, input(), true), null);
          const changing = new ConceptImagesService(db.runtimePool, {
            id: 'changing',
            generate: async () => {
              await admin.concepts.save(
                actor,
                id,
                command(3, { ...document, definition: 'A different apple fruit meaning' }),
              );
              return {
                data: Buffer.from('stale'),
                contentType: 'image/png',
                kind: 'generated',
                provider: 'fixture',
                sourceUrl: null,
                creator: null,
              };
            },
          });
          assert.equal(await changing.image(next, input(), true), null);
          assert.equal(await images.cached(next, 'apple'), null);
        },
      );
      await t.test(
        'migration down/up on disposable data creates multilingual starter apple',
        async () => {
          await db.migrate('down'); // Remove the later assignment queue on this disposable fixture.
          await assert.rejects(
            db.migrate('down'),
            'Authored concepts must prevent destructive rollback',
          );
          assert.equal(
            (await db.adminPool.query('SELECT count(*)::int n FROM product_gotit.lexical_concepts'))
              .rows[0].n,
            2,
          );
          // Explicitly clear only this disposable fixture before rollback rehearsal.
          await db.adminPool.query('DELETE FROM product_gotit.lexical_concepts');
          await db.migrate('down');
          await db.migrate('up');
          assert.equal(
            (
              await db.adminPool.query(
                `SELECT count(*)::int n FROM product_gotit.lexical_concepts WHERE key='apple-fruit'`,
              )
            ).rows[0].n,
            2,
          );
          assert.equal((await images.resolve(input()))?.key, 'apple-fruit');
        },
      );
    } finally {
      await db.dispose();
    }
  },
);
