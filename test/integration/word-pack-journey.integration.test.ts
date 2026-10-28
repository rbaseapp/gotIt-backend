import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTestDatabase } from '../helpers/postgres.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { PROFILE_DEFAULTS } from '../../src/modules/profile/profile.constants.js';
import { WordPackRepository } from '../../src/modules/word-packs/word-packs.repository.js';
import { PostgresPrivateLessonWordPackSource } from '../../src/modules/private-lessons/private-lesson.word-pack.js';

test(
  'unit journey ignores installation, counts distinct known/practised entries, and isolates image/progress by owner',
  { timeout: 150000 },
  async () => {
    const db = await createTestDatabase();
    try {
      const scope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
      const other = { ...scope, applicationUserId: randomUUID() };
      await db.adminPool.query(
        "INSERT INTO core.applications(id,key,name) VALUES($1,'gotit','GotIt')",
        [scope.applicationId],
      );
      for (const owner of [scope, other]) {
        await db.adminPool.query(
          'INSERT INTO core.application_users(id,application_id,email) VALUES($1,$2,$3)',
          [owner.applicationUserId, owner.applicationId, `${owner.applicationUserId}@example.test`],
        );
        await new ProfileRepository(db.runtimePool).ensureAndGet(owner, {
          ...PROFILE_DEFAULTS,
          defaultSourceLanguage: 'en',
          defaultTranslationLanguage: 'he',
        });
      }
      const packs = new WordPackRepository(db.runtimePool);
      const id = 'd3000000-0000-4000-8000-000000000001';
      const initial = await packs.detail(scope, id);
      const ids = initial.entries.map((entry) => String(entry.id));
      assert.equal(initial.pack.progress.introduced, 0);
      assert.ok(initial.pack.teacherStations.every((step) => !step.available));
      await packs.add(scope, id, { entryIds: ids });
      assert.equal((await packs.detail(scope, id)).pack.progress.introduced, 0);
      await packs.setKnown(scope, id, { entryIds: ids.slice(0, 9), known: true });
      assert.equal((await packs.detail(scope, id)).pack.teacherStations[0]!.available, false);
      const linked = await packs.detail(scope, id);
      await db.adminPool.query(
        "UPDATE product_gotit.learning_items SET learning_status='learning' WHERE application_id=$1 AND application_user_id=$2 AND id=ANY($3::uuid[])",
        [
          scope.applicationId,
          scope.applicationUserId,
          linked.entries.slice(0, 10).map((entry) => entry.learningItemId),
        ],
      );
      const ten = await packs.detail(scope, id);
      assert.equal(ten.pack.progress.introduced, 10, 'known and practice overlap is counted once');
      assert.equal(ten.pack.teacherStations[0]!.available, true);
      assert.equal(ten.pack.teacherStations[1]!.available, false);
      assert.equal((await packs.detail(other, id)).pack.progress.introduced, 0);
      await packs.setKnown(scope, id, { entryIds: ids.slice(0, 25), known: true });
      const source = new PostgresPrivateLessonWordPackSource(db.runtimePool);
      assert.deepEqual(
        (await source.context(scope, id, 'midpoint')).context.teacherStations?.map(
          (step) => step.available,
        ),
        [true, true, false],
      );
      await packs.setKnown(scope, id, { entryIds: ids, known: true });
      assert.ok(
        (await packs.detail(scope, id)).pack.teacherStations.every((step) => step.available),
      );
      const entry = linked.entries[0]!;
      await db.adminPool.query(
        "UPDATE product_gotit.learning_items SET study_image_data=$4,study_image_content_type='image/png',study_image_kind='generated',study_image_provider='fixture',study_image_model='fixture',study_image_revision=learning_revision WHERE application_id=$1 AND application_user_id=$2 AND id=$3",
        [
          scope.applicationId,
          scope.applicationUserId,
          entry.learningItemId,
          Buffer.from('fixture'),
        ],
      );
      assert.ok(
        (await packs.image(scope, id, String(entry.id))).image?.url.startsWith('data:image/png'),
      );
      assert.equal((await packs.image(other, id, String(entry.id))).image, null);
      await db.adminPool.query(
        'UPDATE product_gotit.learning_items SET learning_revision=learning_revision+1 WHERE id=$1',
        [entry.learningItemId],
      );
      assert.equal((await packs.image(scope, id, String(entry.id))).image, null);
      await assert.rejects(packs.image(scope, id, randomUUID()));
    } finally {
      await db.dispose();
    }
  },
);
