import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../helpers/postgres.js';
import { ProductAdminService, type AdminActor } from '../../src/modules/admin/admin.service.js';
import { wordImageSchema } from '../../src/modules/admin/admin.word-images.js';
import { wordListSchema } from '../../src/modules/admin/admin.words.js';
import { DEFAULT_LEARNING_POLICY } from '../../src/modules/learning/learning.policy.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { ConceptImagesService } from '../../src/modules/concepts/concept-images.service.js';
import { lookupText } from '../../src/modules/capture/capture.validation.js';

test(
  'new languages reuse one reviewed translation meaning across reads and writes',
  { timeout: 150000 },
  async (t) => {
    const db = await createTestDatabase();
    try {
      const app = randomUUID(),
        foreign = randomUUID(),
        user = randomUUID();
      await db.adminPool.query(
        `INSERT INTO core.applications(id,key,name) VALUES($1,'translation-links','Links'),($2,'links-foreign','Foreign')`,
        [app, foreign],
      );
      await db.adminPool.query(
        `INSERT INTO core.application_users(application_id,id,email) VALUES($1,$2,'links@test.invalid')`,
        [app, user],
      );
      const actor: AdminActor = {
        applicationId: app,
        applicationUserId: user,
        token: 'fixture',
        requestId: randomUUID(),
      };
      const profiles = new ProfileService(new ProfileRepository(db.runtimePool));
      await profiles.getProfile(actor);
      let calls = 0;
      const provider = {
        id: 'fixture',
        generate: async () => {
          calls++;
          return {
            data: Buffer.from('replacement'),
            contentType: 'image/png' as const,
            kind: 'generated' as const,
            provider: 'Fixture',
            sourceUrl: null,
            creator: null,
          };
        },
      };
      const admin = new ProductAdminService(
        db.runtimePool,
        {
          getAdminAccess: async () => ({
            applicationId: app,
            applicationUserId: user,
            mfaEnrolled: true,
            mfaVerified: true,
            permissions: ['content.write' as const],
          }),
          getAdminUser: async () => {
            throw Error('Unexpected user lookup');
          },
        },
        profiles,
        DEFAULT_LEARNING_POLICY,
        undefined,
        undefined,
        undefined,
        { ai: provider },
      );
      const images = new ConceptImagesService(db.runtimePool, provider);
      const input = (sl: string, st: string, tl: string, tt: string) => ({
        scope: actor,
        sourceLanguageCode: sl,
        sourceText: st,
        translationLanguageCode: tl,
        translationText: tt,
        context: null,
      });
      const resolve = (sl: string, st: string, tl: string, tt: string) =>
        images.resolve(input(sl, st, tl, tt));
      async function concept(a: string, forms: string[][], automatic = false, status = 'active') {
        const id = randomUUID();
        await db.adminPool.query(
          `INSERT INTO product_gotit.lexical_concepts(id,application_id,key,title,definition,visual_description,status,automatic_identity) VALUES($1::uuid,$2,$1::text,'southern','Southern meaning','A southern landscape',$3,CASE WHEN $4::boolean THEN product_gotit.word_image_identity($5,$6,$7,$8) END)`,
          [
            id,
            a,
            status,
            automatic,
            forms[0]![0],
            lookupText(forms[0]![1]!),
            forms[1]![0],
            lookupText(forms[1]![1]!),
          ],
        );
        for (const [lang, text] of forms)
          await db.adminPool.query(
            `INSERT INTO product_gotit.concept_expressions(application_id,concept_id,language_code,expression,normalized_text) VALUES($1,$2,$3,$4,$5)`,
            [a, id, lang, text, lookupText(text!)],
          );
        return id;
      }
      async function item(sl: string, st: string, tl: string, tt: string) {
        const id = randomUUID();
        await db.adminPool.query(
          `INSERT INTO product_gotit.learning_items(id,application_id,application_user_id,source_text,normalized_source_text,source_language_code,translation_language_code,item_type) VALUES($1,$2,$3,$4,$5,$6,$7,'word')`,
          [id, app, user, st, lookupText(st), sl, tl],
        );
        await db.adminPool.query(
          `INSERT INTO product_gotit.item_translations(application_id,application_user_id,learning_item_id,translation_text,normalized_text,is_primary,source_kind) VALUES($1,$2,$3,$4,$5,true,'user')`,
          [app, user, id, tt, lookupText(tt)],
        );
        return id;
      }
      const southern = await concept(app, [
        ['en', 'southern'],
        ['he', 'דְרוֹמִי'],
      ]);
      await db.adminPool.query(
        `INSERT INTO product_gotit.concept_image_assets(application_id,concept_id,image_revision,claim_id,claim_until,image_data,image_content_type,image_kind,image_provider,image_model) VALUES($1,$2,1,$3,'epoch',$4,'image/png','generated','Fixture','fixture')`,
        [app, southern, randomUUID(), Buffer.from('southern-picture')],
      );
      const english = await item('en', 'Southern', 'he', 'דְרוֹמִי');
      const arabic = await item('ar', 'جنوبي', 'he', 'דְרוֹמִי');
      // Reproduce the already-created, empty automatic pair from production.
      const emptyAutomatic = await concept(
        app,
        [
          ['ar', 'جنوبي'],
          ['he', 'דְרוֹמִי'],
        ],
        true,
      );

      await t.test(
        'existing and future words share cached bytes, including reverse pairs and whitespace',
        async () => {
          const found = await resolve('ar', 'جنوبي\u00a0', 'he', 'דְרוֹמִי');
          assert.equal(found?.id, southern);
          assert.equal((await resolve('he', 'דְרוֹמִי', 'ar', 'جنوبي'))?.id, southern);
          assert.equal((await resolve('de', 'südlich', 'he', 'דְרוֹמִי'))?.id, southern);
          assert(found);
          assert.equal(
            (await images.image(found, input('ar', 'جنوبي', 'he', 'דְרוֹמִי'), true))?.url,
            `data:image/png;base64,${Buffer.from('southern-picture').toString('base64')}`,
          );
          assert.equal(calls, 0);
          const list = await admin.words.list(actor, wordListSchema.parse({}));
          assert.equal(list.total, 2);
          assert(list.data.every((word: any) => word.conceptId === southern));
          assert.equal(
            (await admin.words.list(actor, wordListSchema.parse({ state: 'unlinked' }))).total,
            0,
          );
          assert.equal(
            (await admin.words.list(actor, wordListSchema.parse({}), arabic)).data.concept.id,
            southern,
          );
          assert.equal(
            (await admin.words.image(actor, english)).data.image?.url,
            (await admin.words.image(actor, arabic)).data.image?.url,
          );
          assert.equal(
            (
              await db.adminPool.query(
                `SELECT count(*)::int n FROM product_gotit.concept_expressions WHERE concept_id=$1 AND language_code='ar'`,
                [southern],
              )
            ).rows[0].n,
            0,
            'Read-only linking must not invent reviewed aliases',
          );
        },
      );
      await t.test(
        'card replacement updates the reviewed shared picture rather than the empty pair',
        async () => {
          const result = await admin.wordImages.replace(
            actor,
            arabic,
            wordImageSchema.parse({
              operationId: randomUUID(),
              reason: 'Shared Arabic image',
              expectedRevision: 1,
              expectedConceptRevision: 0,
              source: 'ai',
            }),
          );
          assert.equal(result.data.conceptId, southern);
          assert.equal(calls, 1);
          assert.equal(
            (await admin.words.image(actor, english)).data.image?.url,
            `data:image/png;base64,${Buffer.from('replacement').toString('base64')}`,
          );
          assert.equal(
            (
              await db.adminPool.query(
                `SELECT count(*)::int n FROM product_gotit.concept_image_assets WHERE concept_id=$1`,
                [emptyAutomatic],
              )
            ).rows[0].n,
            0,
          );
        },
      );
      await t.test(
        'different translations, known conflicting languages, disabled and foreign meanings do not bridge',
        async () => {
          assert.equal(await resolve('ar', 'وجنوب', 'he', 'דָרוֹם'), null);
          assert.equal(await resolve('en', 'northern', 'he', 'דְרוֹמִי'), null);
          assert.equal(await resolve('en', 'southern', 'he', 'דָרוֹם'), null);
          await concept(foreign, [
            ['en', 'west'],
            ['he', 'מערבי'],
          ]);
          await concept(
            app,
            [
              ['en', 'west'],
              ['he', 'מערבי'],
            ],
            false,
            'disabled',
          );
          assert.equal(await resolve('ar', 'غربي', 'he', 'מערבי'), null);
        },
      );
      await t.test(
        'ambiguous translation anchors keep exact automatic pairs; exact reviewed pairs win',
        async () => {
          await concept(app, [
            ['en', 'meridional'],
            ['he', 'דְרוֹמִי'],
          ]);
          assert.equal((await resolve('ar', 'جنوبي', 'he', 'דְרוֹמִי'))?.id, emptyAutomatic);
          assert.equal(await resolve('de', 'südlich', 'he', 'דְרוֹמִי'), null);
          const ambiguous = (
            await db.runtimePool.query(
              `SELECT * FROM product_gotit.resolve_image_concept($1,'de',$2,'he',$3)`,
              [app, 'südlich', 'דְרוֹמִי'],
            )
          ).rows[0];
          assert.equal(ambiguous.ambiguous, true);
          const exact = await concept(app, [
            ['ar', 'جنوبي'],
            ['he', 'דְרוֹמִי'],
          ]);
          assert.equal((await resolve('ar', 'جنوبي', 'he', 'דְרוֹמִי'))?.id, exact);
          assert.equal((await resolve('en', 'southern', 'he', 'דְרוֹמִי'))?.id, southern);
        },
      );
      await t.test('automatic pairs never become transitive language anchors', async () => {
        await concept(
          app,
          [
            ['en', 'blue'],
            ['he', 'כחול'],
          ],
          true,
        );
        assert.equal(await resolve('ar', 'أزرق', 'he', 'כחול'), null);
      });
    } finally {
      await db.dispose();
    }
  },
);
