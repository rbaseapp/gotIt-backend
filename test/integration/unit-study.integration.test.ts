import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTestDatabase } from '../helpers/postgres.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { PROFILE_DEFAULTS } from '../../src/modules/profile/profile.constants.js';
import { WordPackRepository } from '../../src/modules/word-packs/word-packs.repository.js';
import { WordPackStudyService } from '../../src/modules/word-packs/word-pack-study.service.js';

test(
  'unit study media cache persists without learning writes and rejects wrong-unit entries',
  { timeout: 150000 },
  async () => {
    const db = await createTestDatabase();
    try {
      const scope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
      await db.adminPool.query(
        "INSERT INTO core.applications(id,key,name) VALUES($1,'gotit','GotIt')",
        [scope.applicationId],
      );
      await db.adminPool.query(
        'INSERT INTO core.application_users(id,application_id,email) VALUES($1,$2,$3)',
        [scope.applicationUserId, scope.applicationId, 'unit@example.test'],
      );
      const repository = new ProfileRepository(db.runtimePool);
      await repository.ensureAndGet(scope, {
        ...PROFILE_DEFAULTS,
        defaultSourceLanguage: 'en',
        defaultTranslationLanguage: 'he',
      });
      const packs = new WordPackRepository(db.runtimePool);
      const id = 'd3000000-0000-4000-8000-000000000001';
      const otherId = 'd3000000-0000-4000-8000-000000000002';
      const initial = await packs.detail(scope, id);
      let images = 0,
        examples = 0;
      const imageProvider = {
        id: 'unit-fixture',
        generate: async () => {
          images++;
          return {
            data: Buffer.from('image'),
            contentType: 'image/png' as const,
            kind: 'generated' as const,
            provider: 'fixture',
            sourceUrl: null,
            creator: null,
          };
        },
      };
      const study = new WordPackStudyService(db.runtimePool, packs, imageProvider, {
        generate: async () => {
          examples++;
          return 'I am happy.';
        },
      });
      const entryId = String(initial.entries[0]!.id);
      assert.deepEqual(await study.cachedImage(scope, id, entryId), { image: null });
      assert.equal(images, 0, 'GET cache lookup does not contact a provider');
      const media = await study.image(scope, id, entryId);
      assert.ok(media.image?.url.startsWith('data:image/png'));
      assert.deepEqual(await study.example(scope, id, entryId), {
        exampleText: 'I am happy.',
        generated: true,
      });
      await study.example(scope, id, entryId);
      assert.equal(examples, 1, 'example cache avoids repeat provider work');
      const restarted = new WordPackStudyService(db.runtimePool, packs, imageProvider);
      assert.deepEqual(await restarted.image(scope, id, entryId), media);
      assert.equal(images, 1, 'persistent image asset is reused without a library item');
      const after = await packs.detail(scope, id);
      assert.equal(after.pack.installed, false);
      assert.equal(after.pack.progress.linked, 0);
      assert.ok(after.entries.every((entry) => !entry.learningItemId));
      const counts = (
        await db.adminPool.query(
          'SELECT (SELECT count(*) FROM product_gotit.learning_items)::int AS items,(SELECT count(*) FROM product_gotit.practice_sessions)::int AS sessions',
        )
      ).rows[0];
      assert.deepEqual(counts, { items: 0, sessions: 0 });
      await assert.rejects(study.image(scope, otherId, entryId), { code: 'NOT_FOUND' });
      await assert.rejects(study.example(scope, otherId, entryId), { code: 'NOT_FOUND' });
      assert.equal(images, 1);
      assert.equal(examples, 1);
    } finally {
      await db.dispose();
    }
  },
);
