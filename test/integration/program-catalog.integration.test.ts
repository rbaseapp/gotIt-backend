import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../helpers/postgres.js';
import { WordPackRepository } from '../../src/modules/word-packs/word-packs.repository.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { PROFILE_DEFAULTS } from '../../src/modules/profile/profile.constants.js';

test(
  'new-program catalog uses the selected pair without changing saved defaults or owner progress',
  { timeout: 180000 },
  async () => {
    const db = await createTestDatabase();
    try {
      const scope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
      await db.adminPool.query(
        "INSERT INTO core.applications(id,key,name) VALUES($1,'program-catalog-test','Program catalog')",
        [scope.applicationId],
      );
      await db.adminPool.query(
        "INSERT INTO core.application_users(id,application_id,email) VALUES($1,$2,'catalog@example.test')",
        [scope.applicationUserId, scope.applicationId],
      );
      const packs = new WordPackRepository(db.runtimePool);
      const pair = { sourceLanguageCode: 'en', translationLanguageCode: 'he' };
      assert.equal(
        (await packs.list(scope, pair)).packs.filter(
          (p) => p.topic.slug === 'english-learning-path-en-he',
        ).length,
        60,
      );
      const profiles = new ProfileRepository(db.runtimePool);
      await profiles.ensureAndGet(scope, {
        ...PROFILE_DEFAULTS,
        defaultSourceLanguage: 'fr',
        defaultTranslationLanguage: 'he',
      });
      assert.equal((await packs.list(scope)).packs.length, 0);
      const selected = (
        await packs.list(scope, { sourceLanguageCode: 'en-US', translationLanguageCode: 'he-IL' })
      ).packs;
      assert.ok(selected.length > 0);
      assert.ok(
        selected.every(
          (p) =>
            p.track.sourceLanguageCode === 'en' &&
            p.track.translationLanguageCode === 'he' &&
            p.progress.known === 0,
        ),
      );
      assert.equal(
        (await packs.list(scope, { sourceLanguageCode: 'en', translationLanguageCode: 'fr' })).packs
          .length,
        0,
      );
      assert.equal(
        (await packs.list(scope)).packs.length,
        0,
        'read-only discovery preserves profile filtering',
      );
      await assert.rejects(packs.detail(scope, selected[0]!.id), /Word pack not found/);
      await db.adminPool.query(
        "UPDATE product_gotit.user_profiles SET default_source_language='en',default_translation_language='he' WHERE application_id=$1 AND application_user_id=$2",
        [scope.applicationId, scope.applicationUserId],
      );
      assert.ok((await packs.detail(scope, selected[0]!.id)).entries.length > 0);
    } finally {
      await db.dispose();
    }
  },
);
