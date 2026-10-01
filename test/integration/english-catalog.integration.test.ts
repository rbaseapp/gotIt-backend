import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTestDatabase } from '../helpers/postgres.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { PROFILE_DEFAULTS } from '../../src/modules/profile/profile.constants.js';

test(
  'catalog migration remaps only identical words and meanings, preserving unmatched progress in the archive',
  { timeout: 90000 },
  async () => {
    const db = await createTestDatabase();
    try {
      await db.migrate('down');
      const applicationId = randomUUID();
      const userId = randomUUID();
      await db.adminPool.query(
        "INSERT INTO core.applications(id,key,name) VALUES($1,'english-migration-test','English migration test')",
        [applicationId],
      );
      await db.adminPool.query(
        'INSERT INTO core.application_users(id,application_id,email) VALUES($1,$2,$3)',
        [userId, applicationId, 'english-migration@example.test'],
      );
      await new ProfileRepository(db.runtimePool).ensureAndGet(
        { applicationId, applicationUserId: userId },
        PROFILE_DEFAULTS,
      );
      const old = await db.adminPool.query(`SELECT e.id,e.source_text,e.pack_id
        FROM product_gotit.word_pack_entries e
        JOIN product_gotit.word_packs p ON p.id=e.pack_id
        WHERE (p.module_number=12 AND e.source_text='work')
          OR (p.module_number=17 AND e.source_text IN ('may','seek'))
        ORDER BY e.source_text`);
      assert.equal(old.rowCount, 3);
      for (const entry of old.rows)
        await db.adminPool.query(
          `INSERT INTO product_gotit.user_word_pack_known_entries
          (application_id,application_user_id,pack_id,entry_id) VALUES($1,$2,$3,$4)`,
          [applicationId, userId, entry.pack_id, entry.id],
        );
      await db.migrate();
      const known = await db.adminPool.query(
        `SELECT e.source_text,p.module_number
        FROM product_gotit.user_word_pack_known_entries k
        JOIN product_gotit.word_pack_entries e ON e.id=k.entry_id
        JOIN product_gotit.word_packs p ON p.id=e.pack_id
        WHERE k.application_id=$1 AND k.application_user_id=$2`,
        [applicationId, userId],
      );
      assert.deepEqual(known.rows, [{ source_text: 'work', module_number: 2 }]);
      const archived = await db.adminPool.query(
        `SELECT source_text FROM product_gotit.english_catalog_progress_archive
        WHERE kind='known' AND application_id=$1 AND application_user_id=$2 ORDER BY source_text`,
        [applicationId, userId],
      );
      assert.deepEqual(
        archived.rows.map((row) => row.source_text),
        ['may', 'seek', 'work'],
      );
      const month = await db.adminPool.query(
        `SELECT count(*)::int AS count
        FROM product_gotit.user_word_pack_known_entries k
        JOIN product_gotit.word_pack_entries e ON e.id=k.entry_id
        WHERE k.application_id=$1 AND k.application_user_id=$2 AND lower(e.source_text)='may'`,
        [applicationId, userId],
      );
      assert.equal(month.rows[0].count, 0);
    } finally {
      await db.dispose();
    }
  },
);
