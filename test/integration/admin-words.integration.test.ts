import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../helpers/postgres.js';
import { ProductAdminService, type AdminActor } from '../../src/modules/admin/admin.service.js';
import { wordListSchema } from '../../src/modules/admin/admin.words.js';
import { regenerateConceptSchema } from '../../src/modules/admin/admin.concept-regeneration.js';
import { conceptSaveSchema } from '../../src/modules/concepts/concepts.schema.js';
import { listSchema } from '../../src/modules/admin/admin.schemas.js';
import { DEFAULT_LEARNING_POLICY } from '../../src/modules/learning/learning.policy.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { ConceptImagesService } from '../../src/modules/concepts/concept-images.service.js';
import type { StudyImageInput } from '../../src/modules/practice/study-image.provider.js';

test(
  'admin vocabulary covers every learner and replaces shared images atomically',
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
      const learner = randomUUID(),
        foreignApp = randomUUID(),
        foreignUser = randomUUID();
      await db.adminPool.query(
        `INSERT INTO core.applications(id,key,name) VALUES($1,'word-test','Words'),($2,'word-foreign','Foreign')`,
        [actor.applicationId, foreignApp],
      );
      for (const [app, user, email] of [
        [actor.applicationId, actor.applicationUserId, 'admin@test.invalid'],
        [actor.applicationId, learner, 'learner@test.invalid'],
        [foreignApp, foreignUser, 'foreign@test.invalid'],
      ])
        await db.adminPool.query(
          `INSERT INTO core.application_users(application_id,id,email) VALUES($1,$2,$3)`,
          [app, user, email],
        );
      const profiles = new ProfileService(new ProfileRepository(db.runtimePool));
      await profiles.getProfile(actor);
      let allowed = true,
        mfa = true,
        calls = 0,
        fail = false,
        editDuring = false;
      let release: (() => void) | undefined, started: (() => void) | undefined;
      let lastInput: StudyImageInput | undefined;
      const core = {
        getAdminAccess: async () => ({
          applicationId: actor.applicationId,
          applicationUserId: actor.applicationUserId,
          mfaEnrolled: true,
          mfaVerified: mfa,
          permissions: allowed ? ['content.write' as const] : [],
        }),
        getAdminUser: async () => ({
          id: learner,
          status: 'active' as const,
          email: 'learner@test.invalid',
          emailVerified: true,
        }),
      };
      const provider = (kind: 'stock' | 'generated') => ({
        id: `fixture-${kind}`,
        generate: async (input: StudyImageInput) => {
          calls++;
          lastInput = input;
          if (started) {
            started();
            started = undefined;
            await new Promise<void>((r) => {
              release = r;
            });
          }
          if (fail) return null;
          if (editDuring)
            await admin.concepts.save(
              actor,
              conceptId,
              conceptSaveSchema.parse({
                operationId: randomUUID(),
                reason: 'Reviewed meaning changed',
                expectedRevision: currentRevision,
                document: { ...document, definition: 'Another fruit meaning' },
              }),
            );
          return {
            data: Buffer.from(`image-${calls}`),
            contentType: 'image/png' as const,
            kind,
            provider: 'Fixture',
            sourceUrl: kind === 'stock' ? `https://pixabay.com/photos/${calls}/` : null,
            creator: kind === 'stock' ? 'Artist' : null,
          };
        },
      });
      const admin = new ProductAdminService(
        db.runtimePool,
        core,
        profiles,
        DEFAULT_LEARNING_POLICY,
        undefined,
        undefined,
        undefined,
        { stock: provider('stock'), ai: provider('generated') },
      );
      const document = {
        key: 'fruit',
        title: 'Apple fruit',
        definition: 'Edible fruit, not Apple company',
        visualDescription: 'One red apple',
        stockSearchQuery: 'apple fruit isolated',
        status: 'active',
        expressions: [
          { languageCode: 'en', text: 'apple' },
          { languageCode: 'he', text: 'תפוח' },
          { languageCode: 'ar', text: 'تفاحة' },
        ],
      };
      const saved = await admin.concepts.save(
        actor,
        null,
        conceptSaveSchema.parse({
          operationId: randomUUID(),
          reason: 'Reviewed fruit sense',
          expectedRevision: null,
          document,
        }),
      );
      const conceptId = String(saved.data.id);
      const ids: string[] = [];
      for (const [user, app, source, lang, translation] of [
        [actor.applicationUserId, actor.applicationId, 'apple', 'en', 'תפוח'],
        [learner, actor.applicationId, 'تفاحة', 'ar', 'תפוח'],
        [learner, actor.applicationId, 'unknown', 'en', 'לא ידוע'],
        [foreignUser, foreignApp, 'apple', 'en', 'תפוח'],
      ]) {
        const id = randomUUID();
        ids.push(id);
        await db.adminPool.query(
          `INSERT INTO product_gotit.learning_items(id,application_id,application_user_id,source_text,normalized_source_text,source_language_code,translation_language_code,item_type) VALUES($1,$2,$3,$4,$4,$5,'he','word')`,
          [id, app, user, source, lang],
        );
        await db.adminPool.query(
          `INSERT INTO product_gotit.item_translations(application_id,application_user_id,learning_item_id,translation_text,normalized_text,is_primary,source_kind) VALUES($1,$2,$3,$4,$4,true,'user')`,
          [app, user, id, translation],
        );
      }
      await t.test(
        'scoped search, language/user/deletion filters, pagination and full details',
        async () => {
          const all = await admin.words.list(actor, wordListSchema.parse({}));
          assert.equal(all.total, 3);
          assert.equal(all.data.filter((r: any) => r.conceptId === conceptId).length, 2);
          assert.equal(
            (await admin.words.list(actor, wordListSchema.parse({ q: 'תפוח' }))).total,
            2,
          );
          assert.equal((await admin.words.list(actor, wordListSchema.parse({ q: '%' }))).total, 0);
          assert.equal(
            (await admin.words.list(actor, wordListSchema.parse({ sourceLanguageCode: 'ar' })))
              .total,
            1,
          );
          assert.equal(
            (await admin.words.list(actor, wordListSchema.parse({ applicationUserId: learner })))
              .total,
            2,
          );
          assert.equal(
            (await admin.words.list(actor, wordListSchema.parse({ state: 'unlinked' }))).total,
            1,
          );
          assert.equal(
            (await admin.words.list(actor, wordListSchema.parse({ perPage: 1, page: 2 }))).data
              .length,
            1,
          );
          const detail = await admin.words.list(actor, wordListSchema.parse({}), ids[0]);
          assert.equal(detail.data.concept.id, conceptId);
          assert.equal(
            (
              await admin.words.section(
                actor,
                ids[0]!,
                'translations',
                listSchema.parse({ perPage: 1 }),
              )
            ).total,
            1,
          );
          for (const section of ['examples', 'occurrences', 'tags'] as const)
            assert.equal(
              (await admin.words.section(actor, ids[0]!, section, listSchema.parse({}))).total,
              0,
            );
          await assert.rejects(admin.words.image(actor, ids[3]!), { code: 'NOT_FOUND' });
          await assert.rejects(
            admin.words.section(actor, ids[3]!, 'translations', listSchema.parse({})),
            { code: 'NOT_FOUND' },
          );
          await db.adminPool.query(
            `UPDATE product_gotit.learning_items SET deleted_at=now() WHERE id=$1`,
            [ids[2]],
          );
          assert.equal(
            (await admin.words.list(actor, wordListSchema.parse({ state: 'deleted' }))).total,
            1,
          );
          assert.equal(
            (await admin.words.list(actor, wordListSchema.parse({ state: 'active' }))).total,
            2,
          );
          assert.equal(calls, 0, 'reads never call providers');
        },
      );
      let currentRevision = 0;
      const input = (source: 'stock' | 'ai' = 'stock') =>
        regenerateConceptSchema.parse({
          operationId: randomUUID(),
          reason: 'Replace reviewed shared image',
          expectedRevision: currentRevision,
          source,
          prompt: source === 'ai' ? 'A green apple illustration' : '',
          searchQuery: source === 'stock' ? 'apple fruit isolated' : '',
        });
      await t.test('permissions and MFA are checked before any generation', async () => {
        allowed = false;
        await assert.rejects(admin.concepts.regenerate(actor, conceptId, input()), {
          code: 'PERMISSION_REQUIRED',
        });
        allowed = true;
        mfa = false;
        await assert.rejects(admin.concepts.regenerate(actor, conceptId, input()), {
          code: 'ADMIN_MFA_REQUIRED',
        });
        mfa = true;
        assert.equal(calls, 0);
      });
      await t.test(
        'stock replacement shares bytes across users and languages; replay never regenerates',
        async () => {
          const request = input();
          const a = await admin.concepts.regenerate(actor, conceptId, request);
          currentRevision++;
          assert.deepEqual(await admin.concepts.regenerate(actor, conceptId, request), a);
          assert.equal(calls, 1);
          await assert.rejects(
            admin.concepts.regenerate(actor, conceptId, { ...request, searchQuery: 'pear' }),
            { code: 'CONFLICT' },
          );
          const first = await admin.words.image(actor, ids[0]!);
          assert.ok(first.data.image);
          assert.equal(
            first.data.image?.url,
            (await admin.words.image(actor, ids[1]!)).data.image?.url,
          );
          assert.equal(first.data.image?.provider, 'Fixture');
        },
      );
      await t.test(
        'AI prompt bypasses stock; pending and failed replacement retain the old image; retry completes once',
        async () => {
          const old = (await admin.words.image(actor, ids[0]!)).data.image?.url;
          const request = input('ai');
          fail = true;
          const began = new Promise<void>((r) => {
            started = r;
          });
          const work = admin.concepts.regenerate(actor, conceptId, request);
          await began;
          assert.equal((await admin.words.image(actor, ids[1]!)).data.image?.url, old);
          await assert.rejects(admin.concepts.regenerate(actor, conceptId, request), {
            code: 'CONCEPT_IMAGE_UNAVAILABLE',
          });
          release!();
          await assert.rejects(work, { code: 'CONCEPT_IMAGE_UNAVAILABLE' });
          assert.equal((await admin.words.image(actor, ids[0]!)).data.image?.url, old);
          fail = false;
          await admin.concepts.regenerate(actor, conceptId, request);
          currentRevision++;
          assert.deepEqual(lastInput?.visual?.searchQueries, []);
          assert.match(lastInput?.visual?.visualDescription ?? '', /A green apple illustration/);
          assert.equal(lastInput?.context, null);
          assert.equal(lastInput?.excludeSourceUrls?.length, 1);
          assert.notEqual((await admin.words.image(actor, ids[0]!)).data.image?.url, old);
          assert.equal((await admin.words.image(actor, ids[0]!)).data.image?.generated, true);
        },
      );
      await t.test(
        'stale workers cannot publish; edits allocate past reserved revisions; audit records publication',
        async () => {
          editDuring = true;
          await assert.rejects(admin.concepts.regenerate(actor, conceptId, input()), {
            code: 'CONFLICT',
          });
          const concept = (await admin.concepts.list(actor, listSchema.parse({}), conceptId)).data;
          assert.equal(concept.revision, currentRevision + 1);
          const assets = await db.adminPool.query(
            `SELECT image_revision,image_data FROM product_gotit.concept_image_assets WHERE application_id=$1 AND concept_id=$2 ORDER BY image_revision`,
            [actor.applicationId, conceptId],
          );
          assert.equal(assets.rows.at(-1)?.image_data, null);
          assert.ok(concept.imageRevision > assets.rows.at(-1)!.image_revision);
          assert.equal(
            (
              await db.adminPool.query(
                `SELECT count(*)::int n FROM product_gotit.admin_audit_events WHERE action='concept.image.published'`,
              )
            ).rows[0].n,
            2,
          );
          const resolver = new ConceptImagesService(db.runtimePool);
          assert.equal(
            (
              await resolver.resolve({
                scope: actor,
                sourceText: 'apple',
                sourceLanguageCode: 'en',
                translationText: 'תפוח',
                translationLanguageCode: 'he',
                context: null,
              })
            )?.id,
            conceptId,
          );
        },
      );
    } finally {
      await db.dispose();
    }
  },
);
