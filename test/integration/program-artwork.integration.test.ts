import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../helpers/postgres.js';
import { ProgramArtworkService } from '../../src/modules/courses/program-artwork.service.js';
import { CourseService } from '../../src/modules/courses/course.service.js';
import { PostgresLearningDocumentStore } from '../../src/modules/courses/course.repository.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { PROFILE_DEFAULTS } from '../../src/modules/profile/profile.constants.js';
import { courseFixture, plan, profiles } from '../helpers/course-fixtures.js';
import { AppError } from '../../src/shared/errors/app-error.js';

test(
  'program artwork persists with runtime grants, isolates owners, and survives a service restart without new learning writes',
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
        [scope.applicationUserId, scope.applicationId, 'artwork@example.test'],
      );
      await new ProfileRepository(db.runtimePool).ensureAndGet(scope, PROFILE_DEFAULTS);
      const store = new PostgresLearningDocumentStore(db.runtimePool);
      const course = courseFixture();
      course.versions = [
        { version: 1, preferences: course.preferences, plan, createdAt: course.createdAt },
      ];
      course.activeVersion = 1;
      await store.save(scope, course, null, randomUUID(), 'artwork-fixture');
      const courses = new CourseService(store, profiles);
      let calls = 0;
      const image = await sharp({
        create: { width: 512, height: 512, channels: 3, background: '#28735f' },
      })
        .webp()
        .toBuffer();
      const fetcher = (async () => {
        calls++;
        return new Response(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }));
      }) as typeof fetch;
      const first = new ProgramArtworkService(
        db.runtimePool,
        courses,
        'fixture',
        'fixture-model',
        undefined,
        fetcher,
      );
      const input = { kind: 'course' as const, courseId: course.id };
      const result = await first.artwork(scope, input, true);
      const restarted = new ProgramArtworkService(
        db.runtimePool,
        courses,
        'fixture',
        'fixture-model',
        undefined,
        fetcher,
      );
      assert.deepEqual(await restarted.artwork(scope, input, false), result);
      assert.equal(calls, 1);
      await assert.rejects(
        restarted.artwork({ ...scope, applicationUserId: randomUUID() }, input, true),
        (e: unknown) => e instanceof AppError && e.statusCode === 404,
      );
      const cached = await db.adminPool.query(
        "SELECT visual_brief,octet_length(image_data) bytes FROM product_gotit.study_image_assets WHERE normalized_translation_text='program-artwork'",
      );
      assert.equal(cached.rows.length, 1);
      assert.deepEqual(cached.rows[0].visual_brief, { kind: 'course', policy: 'program-clay-v1' });
      assert.ok(cached.rows[0].bytes < 100000);
      assert.equal((await store.get(scope, course.id))!.revision, 0);
      assert.equal(
        (await db.runtimePool.query('SELECT count(*)::int count FROM product_gotit.learning_items'))
          .rows[0].count,
        0,
      );
    } finally {
      await db.dispose();
    }
  },
);
