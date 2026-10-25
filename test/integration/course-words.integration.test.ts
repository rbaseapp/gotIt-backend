import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../helpers/postgres.js';
import { PostgresCourseWordSource } from '../../src/modules/courses/course.words.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { PROFILE_DEFAULTS } from '../../src/modules/profile/profile.constants.js';
import { lookupText } from '../../src/modules/capture/capture.validation.js';

test(
  'course words retain separate senses and exclude foreign, other-pair, archived and deleted items',
  { timeout: 150000 },
  async () => {
    const db = await createTestDatabase();
    try {
      const applicationId = randomUUID(),
        applicationUserId = randomUUID(),
        foreignUser = randomUUID();
      await db.adminPool.query(
        "INSERT INTO core.applications(id,key,name) VALUES($1,'course-words','Course words')",
        [applicationId],
      );
      for (const id of [applicationUserId, foreignUser]) {
        await db.adminPool.query(
          'INSERT INTO core.application_users(id,application_id,email) VALUES($1,$2,$3)',
          [id, applicationId, `${id}@example.test`],
        );
        await new ProfileRepository(db.runtimePool).ensureAndGet(
          { applicationId, applicationUserId: id },
          PROFILE_DEFAULTS,
        );
      }
      const ids: string[] = [];
      for (const [user, translationLanguage, translation, status, deleted] of [
        [applicationUserId, 'ar', 'ماء', 'active', false],
        [applicationUserId, 'ar', 'يسقي', 'active', false],
        [applicationUserId, 'he', 'מים', 'active', false],
        [foreignUser, 'ar', 'ماء', 'active', false],
        [applicationUserId, 'ar', 'قديم', 'archived', false],
        [applicationUserId, 'ar', 'محذوف', 'active', true],
      ] as const) {
        const id = randomUUID();
        ids.push(id);
        await db.runtimePool.query(
          `INSERT INTO product_gotit.learning_items(id,application_id,application_user_id,source_text,normalized_source_text,source_language_code,translation_language_code,item_type,user_status,deleted_at) VALUES($1,$2,$3,'water','water','en',$4,'word',$5,$6)`,
          [id, applicationId, user, translationLanguage, status, deleted ? new Date() : null],
        );
        await db.runtimePool.query(
          `INSERT INTO product_gotit.item_translations(application_id,application_user_id,learning_item_id,translation_text,normalized_text,is_primary,source_kind) VALUES($1,$2,$3,$4,$5,true,'user')`,
          [applicationId, user, id, translation, lookupText(translation)],
        );
      }
      const source = new PostgresCourseWordSource(db.runtimePool);
      const words = await source.resolve(
        { applicationId, applicationUserId },
        [' WＡTER ', 'missing'],
        'en',
        'ar',
      );
      assert.deepEqual(
        new Set(words[0]!.choices.map((choice) => choice.id)),
        new Set(ids.slice(0, 2)),
      );
      assert.deepEqual(words[1], { sourceText: 'missing', choices: [] });
      assert.deepEqual(
        await source.resolve(
          { applicationId: randomUUID(), applicationUserId },
          ['water'],
          'en',
          'ar',
        ),
        [{ sourceText: 'water', choices: [] }],
      );
    } finally {
      await db.dispose();
    }
  },
);
