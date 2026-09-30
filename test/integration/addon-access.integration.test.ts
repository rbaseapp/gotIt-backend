import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PostgresAddonAccess } from '../../src/modules/addons/addon-access.js';
import { PROFILE_DEFAULTS } from '../../src/modules/profile/profile.constants.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { createTestDatabase } from '../helpers/postgres.js';

test(
  'add-on cycles enforce approved packages, concurrent lesson limits, renewal and release',
  { timeout: 150_000 },
  async () => {
    const db = await createTestDatabase();
    try {
      const scope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
      await db.adminPool.query(
        `INSERT INTO core.applications(id,key,name) VALUES($1,'gotit','GotIt')`,
        [scope.applicationId],
      );
      await db.adminPool.query(
        `INSERT INTO core.application_users(id,application_id,email) VALUES($1,$2,'addon@example.test')`,
        [scope.applicationUserId, scope.applicationId],
      );
      await new ProfileRepository(db.runtimePool).ensureAndGet(scope, PROFILE_DEFAULTS);
      const access = new PostgresAddonAccess(db.runtimePool);
      assert.equal(await access.status(scope, 'ai'), null);
      assert.equal(await access.status(scope, 'private_lessons'), null);

      const packages = await db.adminPool.query(
        `SELECT key,lessons_per_cycle,lesson_duration_seconds,active FROM product_gotit.addon_packages ORDER BY key`,
      );
      assert.deepEqual(
        packages.rows.map((row) => [row.key, row.lessons_per_cycle]),
        [
          ['ai', null],
          ['lessons-12', 12],
          ['lessons-2', 2],
          ['lessons-4', 4],
          ['lessons-8', 8],
        ],
      );
      assert.ok(
        packages.rows.every((row) => row.active === false && row.lesson_duration_seconds === null),
      );

      const now = Date.now();
      const starts = new Date(now - 60_000);
      const ends = new Date(now + 60_000);
      const insert = (start: Date, end: Date, packageKey = 'lessons-2', limit = 2) =>
        db.adminPool.query(
          `INSERT INTO product_gotit.addon_cycles(application_id,application_user_id,package_key,kind,starts_at,ends_at,lesson_limit,lesson_duration_seconds)
         VALUES($1,$2,$3,'private_lessons',$4,$5,$6,600)`,
          [scope.applicationId, scope.applicationUserId, packageKey, start, end, limit],
        );
      await assert.rejects(insert(starts, ends), /inactive|approved package/u);
      await db.adminPool.query(
        `UPDATE product_gotit.addon_packages SET active=true,lesson_duration_seconds=600 WHERE key='lessons-2'`,
      );
      await assert.rejects(insert(starts, ends, 'lessons-2', 4), /terms do not match/u);
      await insert(starts, ends);
      await assert.rejects(insert(starts, ends), /Overlapping add-on cycles/u);
      const futureStarts = new Date(now + 120_000);
      const futureEnds = new Date(now + 180_000);
      const overlapping = await Promise.allSettled([
        insert(futureStarts, futureEnds),
        insert(futureStarts, futureEnds),
      ]);
      assert.equal(overlapping.filter((item) => item.status === 'fulfilled').length, 1);

      const ids = [randomUUID(), randomUUID(), randomUUID()];
      const outcomes = await Promise.allSettled(ids.map((id) => access.reserveLesson(scope, id)));
      assert.equal(outcomes.filter((item) => item.status === 'fulfilled').length, 2);
      const rejection = outcomes.find((item) => item.status === 'rejected');
      assert.equal(
        rejection?.status === 'rejected' && rejection.reason.code,
        'PRIVATE_LESSON_LIMIT_REACHED',
      );
      const status = await access.status(scope, 'private_lessons');
      assert.equal(status?.lessonsUsed, 2);
      assert.equal(status?.lessonsRemaining, 0);
      assert.equal(status?.lessonDurationSeconds, 600);

      const usedId = ids[outcomes.findIndex((item) => item.status === 'fulfilled')]!;
      await access.releaseLesson(usedId);
      await access.releaseLesson(usedId);
      assert.equal((await access.status(scope, 'private_lessons'))?.lessonsUsed, 1);
      await access.reserveLesson(scope, randomUUID());
      assert.equal((await access.status(scope, 'private_lessons'))?.lessonsUsed, 2);

      await db.adminPool.query(
        `UPDATE product_gotit.addon_cycles SET starts_at=$2,ends_at=$3 WHERE id=$1`,
        [status!.cycleId, new Date(now - 180_000), new Date(now - 120_000)],
      );
      assert.equal(await access.status(scope, 'private_lessons'), null);
      await insert(starts, ends);
      assert.equal((await access.status(scope, 'private_lessons'))?.lessonsUsed, 0);
      assert.equal((await access.reserveLesson(scope, randomUUID())).lessonsRemaining, 1);
    } finally {
      await db.dispose();
    }
  },
);
