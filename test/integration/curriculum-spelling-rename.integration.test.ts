import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTestDatabase } from '../helpers/postgres.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import { CurriculumStore } from '../../src/modules/curriculum/curriculum.store.js';
import { CurriculumService } from '../../src/modules/curriculum/curriculum.service.js';
import { PracticeService } from '../../src/modules/practice/practice.service.js';
import { sessionSchema } from '../../src/modules/practice/practice.validation.js';
import { lexicon } from '../../src/modules/curriculum/curriculum.content.js';

test(
  'a target spelling revision renames existing practice items only when former_en lists the old text',
  { timeout: 180000 },
  async () => {
    const db = await createTestDatabase();
    const [renamed, unlisted] = lexicon.targets.filter((word) => word.unit === 'P01');
    assert.ok(renamed && unlisted);
    const original = { renamed: { ...renamed }, unlisted: { ...unlisted } };
    try {
      const applicationId = randomUUID(),
        userId = randomUUID();
      await db.adminPool.query(
        "INSERT INTO core.applications(id,key,name) VALUES($1,$2,'Spelling rename')",
        [applicationId, randomUUID()],
      );
      await db.adminPool.query(
        "INSERT INTO core.application_users(application_id,id,email) VALUES($1,$2,'rename@example.test')",
        [applicationId, userId],
      );
      const scope = { applicationId, applicationUserId: userId };
      const profiles = new ProfileService(new ProfileRepository(db.runtimePool));
      const store = new CurriculumStore(db.runtimePool);
      const curriculum = new CurriculumService(store, profiles);
      const practice = new PracticeService(db.runtimePool, profiles, undefined, () => true);
      await db.adminPool.query(
        "UPDATE product_gotit.structured_program_versions SET visible=true WHERE program_id='english-zero-c1'",
      );
      await curriculum.enroll(scope, { eventId: randomUUID(), minutes: 20, literacy: 'starting' });
      const input = sessionSchema.parse({
        sessionType: 'smart_review',
        curriculumUnitId: 'P01',
        sourceLanguageCode: 'en',
        count: 1,
        includeNewItems: true,
      });
      await practice.createSession(scope, randomUUID(), input);
      const itemId = (await store.get(scope))!.state.practiceItems![renamed.id]!;
      const sourceText = async () =>
        (
          await db.adminPool.query(
            'SELECT source_text,normalized_source_text FROM product_gotit.learning_items WHERE id=$1',
            [itemId],
          )
        ).rows[0];

      // Revised spelling with the old text kept in former_en: progress is kept.
      renamed.former_en = [renamed.en];
      renamed.en = `${original.renamed.en}-revised`;
      await practice.createSession(scope, randomUUID(), input);
      assert.equal((await store.get(scope))!.state.practiceItems![renamed.id], itemId);
      const after = await sourceText();
      assert.equal(after.source_text, renamed.en);
      assert.equal(after.normalized_source_text, renamed.en);

      // A changed text without former_en is still rejected as stale content.
      unlisted.en = `${original.unlisted.en}-changed`;
      await assert.rejects(practice.createSession(scope, randomUUID(), input), /changed/i);
    } finally {
      Object.assign(renamed, original.renamed);
      delete renamed.former_en;
      Object.assign(unlisted, original.unlisted);
      await db.dispose();
    }
  },
);
