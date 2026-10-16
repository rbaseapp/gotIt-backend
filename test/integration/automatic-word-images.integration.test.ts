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

test(
  'automatic word images backfill current media and support direct card actions',
  { timeout: 150000 },
  async (t) => {
    const db = await createTestDatabase();
    try {
      await db.migrate('down'); // Read-only translation resolver.
      await db.migrate('down');
      const app = randomUUID(),
        foreign = randomUUID(),
        user = randomUUID(),
        other = randomUUID(),
        foreignUser = randomUUID();
      const actor: AdminActor = {
        applicationId: app,
        applicationUserId: user,
        token: 'fixture',
        requestId: randomUUID(),
      };
      await db.adminPool.query(
        `INSERT INTO core.applications(id,key,name) VALUES($1,'auto-images','Auto'),($2,'auto-foreign','Foreign')`,
        [app, foreign],
      );
      const profiles = new ProfileService(new ProfileRepository(db.runtimePool));
      for (const [a, u] of [
        [app, user],
        [app, other],
        [foreign, foreignUser],
      ] as const) {
        await db.adminPool.query(
          `INSERT INTO core.application_users(application_id,id,email) VALUES($1,$2,$3)`,
          [a, u, `${u}@test.invalid`],
        );
        await profiles.getProfile({ applicationId: a, applicationUserId: u });
      }
      async function item(
        a: string,
        u: string,
        sl: string,
        st: string,
        tl: string,
        tt: string,
        media = false,
      ) {
        const id = randomUUID();
        await db.adminPool.query(
          `INSERT INTO product_gotit.learning_items(id,application_id,application_user_id,source_text,normalized_source_text,source_language_code,translation_language_code,item_type,overall_mastery_score,review_stage) VALUES($1,$2,$3,$4,$4,$5,$6,'word',42,2)`,
          [id, a, u, st, sl, tl],
        );
        await db.adminPool.query(
          `INSERT INTO product_gotit.item_translations(application_id,application_user_id,learning_item_id,translation_text,normalized_text,is_primary,source_kind) VALUES($1,$2,$3,$4,$4,true,'user')`,
          [a, u, id, tt],
        );
        if (media)
          await db.adminPool.query(
            `UPDATE product_gotit.learning_items SET study_image_data=$2,study_image_content_type='image/png',study_image_kind='generated',study_image_provider='Fixture',study_image_model='legacy',study_image_revision=learning_revision WHERE id=$1`,
            [id, Buffer.from('old-picture')],
          );
        return id;
      }
      const apple = await item(app, user, 'en', 'apple', 'he', 'תפוח', true);
      const reverse = await item(app, other, 'he', 'תפוח', 'en', 'apple');
      const money = await item(app, user, 'en', 'bank', 'he', 'בנק');
      const river = await item(app, other, 'en', 'bank', 'he', 'גדה');
      const alien = await item(foreign, foreignUser, 'en', 'apple', 'he', 'תפוח', true);
      await db.adminPool.query(
        `INSERT INTO product_gotit.study_image_assets(source_language_code,normalized_source_text,translation_language_code,normalized_translation_text,image_model,sense_key,visual_brief,image_data,image_content_type,image_kind,image_provider) VALUES('en','grape','he','ענב','legacy','grape','{}',$1,'image/png','generated','Fixture')`,
        [Buffer.from('catalog-picture')],
      );
      await db.migrate('up');
      let mfa = true,
        allowed = true,
        calls = 0,
        fail = false,
        stale = false;
      const provider = {
        id: 'fixture',
        generate: async (input: any) => {
          calls++;
          assert.equal(input.context, null);
          if (stale)
            await db.adminPool.query(
              `UPDATE product_gotit.learning_items SET learning_revision=learning_revision+1 WHERE id=$1`,
              [future],
            );
          return fail
            ? null
            : {
                data: Buffer.from('new-picture'),
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
            mfaVerified: mfa,
            permissions: allowed ? ['content.write' as const] : [],
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
      const imageService = new ConceptImagesService(db.runtimePool);
      const resolve = (sl: string, st: string, tl: string, tt: string) =>
        imageService.resolve({
          scope: actor,
          sourceLanguageCode: sl,
          sourceText: st,
          translationLanguageCode: tl,
          translationText: tt,
          context: null,
        });
      await t.test(
        'historical words and catalog images link in both directions without merging homonyms or applications',
        async () => {
          const words = await admin.words.list(actor, wordListSchema.parse({}));
          assert.equal(words.total, 4);
          assert(words.data.every((w: any) => w.conceptId));
          const a = words.data.find((w: any) => w.id === apple),
            b = words.data.find((w: any) => w.id === reverse);
          assert.equal(a.conceptId, b.conceptId);
          assert.notEqual(
            words.data.find((w: any) => w.id === money).conceptId,
            words.data.find((w: any) => w.id === river).conceptId,
          );
          const picture = (await admin.words.image(actor, reverse)).data.image;
          assert.equal(
            picture?.url,
            `data:image/png;base64,${Buffer.from('old-picture').toString('base64')}`,
          );
          const c = await resolve('en', 'grape', 'he', 'ענב');
          assert(c);
          assert.equal(
            (await imageService.cached(c, 'grape'))?.url,
            `data:image/png;base64,${Buffer.from('catalog-picture').toString('base64')}`,
          );
          await assert.rejects(admin.words.image(actor, alien), { statusCode: 404 });
          const learning = (
            await db.adminPool.query(
              `SELECT overall_mastery_score,review_stage,learning_revision FROM product_gotit.learning_items WHERE id=$1`,
              [apple],
            )
          ).rows[0];
          assert.equal(Number(learning.overall_mastery_score), 42);
          assert.equal(learning.review_stage, 2);
          assert.equal(learning.learning_revision, 1);
          const old = (
            await db.adminPool.query(
              `SELECT study_image_data FROM product_gotit.learning_items WHERE id=$1`,
              [apple],
            )
          ).rows[0];
          assert.deepEqual(old.study_image_data, Buffer.from('old-picture'));
        },
      );
      const future = await item(app, user, 'en', 'pear', 'he', 'אגס', true);
      const input = wordImageSchema.parse({
        operationId: randomUUID(),
        reason: 'Generate from card',
        expectedRevision: 1,
        source: 'ai',
      });
      await t.test(
        'future words need no manual meaning setup; MFA precedes linking and old bytes survive failed generation',
        async () => {
          mfa = false;
          await assert.rejects(admin.wordImages.replace(actor, future, input), {
            code: 'ADMIN_MFA_REQUIRED',
          });
          assert.equal(await resolve('en', 'pear', 'he', 'אגס'), null);
          assert.equal(calls, 0);
          mfa = true;
          allowed = false;
          await assert.rejects(admin.wordImages.replace(actor, future, input), {
            code: 'PERMISSION_REQUIRED',
          });
          allowed = true;
          fail = true;
          await assert.rejects(admin.wordImages.replace(actor, future, input), {
            code: 'CONCEPT_IMAGE_UNAVAILABLE',
          });
          const c = await resolve('en', 'pear', 'he', 'אגס');
          assert(c);
          assert.equal(
            (await imageService.cached(c, 'pear'))?.url,
            `data:image/png;base64,${Buffer.from('old-picture').toString('base64')}`,
          );
        },
      );
      await t.test(
        'retry and completed replay never repeat paid work; a changed payload conflicts',
        async () => {
          fail = false;
          const result = await admin.wordImages.replace(actor, future, input);
          assert.equal(result.data.id, future);
          assert.equal(calls, 2);
          assert.deepEqual(await admin.wordImages.replace(actor, future, input), result);
          assert.equal(calls, 2);
          await assert.rejects(
            admin.wordImages.replace(actor, future, { ...input, prompt: 'changed' }),
            { code: 'CONFLICT' },
          );
          assert.equal(calls, 2);
        },
      );
      await t.test(
        'item revision changes during generation cannot publish stale media',
        async () => {
          stale = true;
          const before = await resolve('en', 'pear', 'he', 'אגס');
          await assert.rejects(
            admin.wordImages.replace(actor, future, {
              ...input,
              operationId: randomUUID(),
              prompt: 'Another picture',
            }),
            { code: 'CONFLICT' },
          );
          assert.equal(
            (await resolve('en', 'pear', 'he', 'אגס'))?.image_revision,
            before?.image_revision,
          );
          stale = false;
        },
      );
      await t.test(
        'authored automatic identities prevent destructive migration rollback',
        async () => {
          const banana = await item(app, user, 'en', 'banana', 'he', 'בננה');
          await db.adminPool.query(
            `INSERT INTO product_gotit.study_image_assets(source_language_code,normalized_source_text,translation_language_code,normalized_translation_text,image_model,sense_key,visual_brief,image_data,image_content_type,image_kind,image_provider) VALUES('en','banana','he','בננה','legacy','banana','{}',$1,'image/png','generated','Fixture')`,
            [Buffer.from('later-catalog-picture')],
          );
          fail = true;
          await assert.rejects(
            admin.wordImages.replace(actor, banana, { ...input, operationId: randomUUID() }),
            { code: 'CONCEPT_IMAGE_UNAVAILABLE' },
          );
          const linked = await resolve('en', 'banana', 'he', 'בננה');
          assert(linked);
          assert.equal(
            (await imageService.cached(linked, 'banana'))?.url,
            `data:image/png;base64,${Buffer.from('later-catalog-picture').toString('base64')}`,
          );
          await db.migrate('down'); // Resolver rollback retains all meanings and media.
          await assert.rejects(db.migrate('down'));
        },
      );
    } finally {
      await db.dispose();
    }
  },
);
