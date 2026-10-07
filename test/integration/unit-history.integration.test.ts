import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PracticeService } from '../../src/modules/practice/practice.service.js';
import type { ProfileScope } from '../../src/modules/profile/profile.types.js';
import { createTestDatabase } from '../helpers/postgres.js';

test(
  'pack history filters records and totals with language, pagination and ownership',
  { timeout: 150000 },
  async () => {
    const db = await createTestDatabase();
    try {
      const owner = { applicationId: randomUUID(), applicationUserId: randomUUID() };
      const otherUser = { ...owner, applicationUserId: randomUUID() };
      const otherApp = { applicationId: randomUUID(), applicationUserId: randomUUID() };
      for (const [index, scope] of [owner, otherApp].entries()) {
        await db.adminPool.query('INSERT INTO core.applications(id,key,name) VALUES($1,$2,$3)', [
          scope.applicationId,
          `history-${index}`,
          `History ${index}`,
        ]);
      }
      for (const [index, scope] of [owner, otherUser, otherApp].entries()) {
        await db.adminPool.query(
          'INSERT INTO core.application_users(id,application_id,email) VALUES($1,$2,$3)',
          [scope.applicationUserId, scope.applicationId, `history-${index}@example.test`],
        );
      }
      const items = new Map<string, string>();
      for (const language of ['en', 'he']) {
        const id = randomUUID();
        await db.adminPool.query(
          `INSERT INTO product_gotit.learning_items
          (id,application_id,application_user_id,source_text,normalized_source_text,
           source_language_code,translation_language_code,item_type)
         VALUES($1,$2,$3,'fixture','fixture',$4,'fr','word')`,
          [id, owner.applicationId, owner.applicationUserId, language],
        );
        items.set(language, id);
      }
      const packId = randomUUID();
      let sequence = 0;
      async function seed(
        scope: ProfileScope,
        selectionScope: { type: string; id: string } | null,
        language = 'en',
      ) {
        const id = randomUUID();
        await db.adminPool.query(
          `INSERT INTO product_gotit.practice_sessions
          (id,application_id,application_user_id,session_type,status,started_at,selection)
         VALUES($1,$2,$3,'smart_review','active',$4,$5)`,
          [
            id,
            scope.applicationId,
            scope.applicationUserId,
            new Date(Date.UTC(2026, 9, 7, 0, 0, sequence++)),
            { scope: selectionScope, itemIds: scope === owner ? [items.get(language)] : [] },
          ],
        );
        return id;
      }
      const pack = { type: 'pack', id: packId };
      const first = await seed(owner, pack);
      const second = await seed(owner, pack, 'he');
      const latest = await seed(owner, pack);
      await seed(owner, { type: 'pack', id: randomUUID() });
      await seed(owner, { type: 'track', id: packId });
      await seed(owner, null);
      const foreignCursor = await seed(otherUser, pack);
      await seed(otherApp, pack);

      const practice = new PracticeService(db.runtimePool, {} as never);
      const history = await practice.sessions(owner, 50, undefined, undefined, packId);
      assert.equal(history.totalCount, 3);
      assert.deepEqual(
        history.items.map((item) => item.id),
        [latest, second, first],
      );
      assert.equal(history.nextCursor, null);
      assert.equal((await practice.sessions(owner, 50)).totalCount, 6);

      const english = await practice.sessions(owner, 50, undefined, 'en', packId.toUpperCase());
      assert.equal(english.totalCount, 2);
      assert.deepEqual(
        english.items.map((item) => item.id),
        [latest, first],
      );
      const page = await practice.sessions(owner, 1, undefined, undefined, packId);
      assert.equal(page.totalCount, 3);
      assert.deepEqual(
        page.items.map((item) => item.id),
        [latest],
      );
      assert.equal(page.nextCursor, latest);
      const remaining = await practice.sessions(owner, 50, page.nextCursor!, undefined, packId);
      assert.equal(remaining.totalCount, 3);
      assert.deepEqual(
        remaining.items.map((item) => item.id),
        [second, first],
      );
      assert.equal(remaining.nextCursor, null);

      assert.equal(
        (await practice.sessions(otherUser, 50, undefined, undefined, packId)).totalCount,
        1,
      );
      assert.equal(
        (await practice.sessions(otherApp, 50, undefined, undefined, packId)).totalCount,
        1,
      );
      const foreignPage = await practice.sessions(owner, 50, foreignCursor, undefined, packId);
      assert.deepEqual(foreignPage.items, []);
      assert.equal(foreignPage.totalCount, 3);
      const missing = await practice.sessions(owner, 50, undefined, undefined, randomUUID());
      assert.deepEqual(missing, { items: [], nextCursor: null, totalCount: 0 });
    } finally {
      await db.dispose();
    }
  },
);
