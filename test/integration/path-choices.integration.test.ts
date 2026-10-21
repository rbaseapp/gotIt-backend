import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../helpers/postgres.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import { CurriculumStore } from '../../src/modules/curriculum/curriculum.store.js';
import { CurriculumService } from '../../src/modules/curriculum/curriculum.service.js';
import { CourseService } from '../../src/modules/courses/course.service.js';
import { PostgresLearningDocumentStore } from '../../src/modules/courses/course.repository.js';
import { courseFixture, plan } from '../helpers/course-fixtures.js';
import { buildUnitLearningPath } from '../../src/modules/word-packs/unit-learning-path.js';
import { WordPackRepository } from '../../src/modules/word-packs/word-packs.repository.js';

test(
  'persisted path choices isolate owners, serialize races and preserve all learning evidence',
  { timeout: 180000 },
  async () => {
    const db = await createTestDatabase();
    try {
      const applicationId = randomUUID(),
        userId = randomUUID(),
        otherId = randomUUID();
      await db.adminPool.query(
        "INSERT INTO core.applications(id,key,name) VALUES($1,$2,'Path choices')",
        [applicationId, randomUUID()],
      );
      await db.adminPool.query(
        "INSERT INTO core.application_users(application_id,id,email) VALUES($1,$2,'path@example.test'),($1,$3,'other-path@example.test')",
        [applicationId, userId, otherId],
      );
      const scope = { applicationId, applicationUserId: userId },
        other = { applicationId, applicationUserId: otherId };
      const profiles = new ProfileService(new ProfileRepository(db.runtimePool));
      const store = new CurriculumStore(db.runtimePool),
        curriculum = new CurriculumService(store, profiles);
      await db.adminPool.query(
        "UPDATE product_gotit.structured_program_versions SET visible=true WHERE program_id='english-zero-c1'",
      );
      for (const owner of [scope, other])
        await curriculum.enroll(owner, {
          eventId: randomUUID(),
          minutes: 20,
          literacy: 'starting',
        });
      const before = (await store.get(scope))!;
      assert.equal((await curriculum.prepareLesson(scope, 'C118-L2')).context.lessonId, 'C118-L2');
      const input = {
        eventId: randomUUID(),
        revision: before.revision,
        unitId: 'P01',
        skipped: true,
      };
      const [one, two] = await Promise.all([
        curriculum.pathChoice(scope, input),
        curriculum.pathChoice(scope, input),
      ]);
      assert.deepEqual(one, two);
      const skipped = await curriculum.get(scope);
      assert.equal(skipped.currentUnit, 'P02');
      assert.equal(skipped.units[0]!.skipped, true);
      assert.deepEqual((await store.get(scope))!.state.words, before.state.words);
      assert.deepEqual((await store.get(scope))!.state.completed, before.state.completed);
      assert.equal(skipped.graduation.complete, false);
      assert.equal((await curriculum.get(other)).units[0]!.skipped, false);
      await assert.rejects(curriculum.pathChoice(scope, { ...input, skipped: false }), {
        code: 'CURRICULUM_CHANGED',
      });
      const race = await Promise.allSettled(
        [true, false].map((skipped) =>
          curriculum.pathChoice(scope, {
            ...input,
            eventId: randomUUID(),
            revision: before.revision + 1,
            unitId: 'P02',
            skipped,
          }),
        ),
      );
      assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
      await curriculum.pathChoice(scope, {
        eventId: randomUUID(),
        revision: (await curriculum.get(scope)).revision,
        unitId: 'P01',
        skipped: false,
      });
      assert.equal((await curriculum.get(scope)).currentUnit, 'P01');
      const step = {
        eventId: randomUUID(),
        revision: (await curriculum.get(scope)).revision,
        unitId: 'P01',
        activityId: 'teacher:P01-L1',
        skipped: true,
      };
      await curriculum.pathChoice(scope, step);
      const path = await curriculum.unit(scope, 'P01');
      assert.equal(path.pathSteps.find((item) => item.id === 'teacher:P01-L1')?.skipped, true);
      assert.equal(path.pathSteps.find((item) => item.id === 'post:P01-L1')?.skipped, true);
      await assert.rejects(
        curriculum.pathChoice(scope, {
          ...step,
          eventId: randomUUID(),
          revision: (await curriculum.get(scope)).revision,
          activityId: 'teacher:P02-L1',
        }),
        { code: 'CURRICULUM_NOT_FOUND' },
      );
      assert.equal(
        (
          await db.runtimePool.query(
            'SELECT count(*)::int n FROM product_gotit.xp_events WHERE application_id=$1 AND application_user_id=$2',
            [applicationId, userId],
          )
        ).rows[0]!.n,
        0,
      );

      const documents = new PostgresLearningDocumentStore(db.runtimePool),
        courses = new CourseService(documents, profiles);
      const course = courseFixture();
      course.activeVersion = 1;
      course.versions = [
        { version: 1, preferences: course.preferences, plan, createdAt: course.createdAt },
      ];
      await documents.save(scope, course, null, randomUUID(), 'fixture-course');
      const selected = await courses.lessonContext(scope, course.id, {
        version: 1,
        unitKey: 'advanced',
        lessonIndex: 1,
      });
      assert.equal(selected.unitKey, 'advanced');
      await courses.pathChoice(scope, course.id, {
        version: 1,
        revision: 0,
        eventId: randomUUID(),
        unitKey: 'foundation',
        skipped: true,
      });
      const reloaded = new CourseService(
        new PostgresLearningDocumentStore(db.runtimePool),
        profiles,
      );
      assert.equal((await reloaded.course(scope, course.id)).skippedLessons?.length, 2);
      await assert.rejects(
        reloaded.lessonContext(other, course.id, {
          version: 1,
          unitKey: 'advanced',
          lessonIndex: 1,
        }),
        { code: 'COURSE_NOT_FOUND' },
      );
      const packs = new WordPackRepository(db.runtimePool);
      const packId =
        (
          await db.adminPool.query(
            "SELECT id FROM product_gotit.word_packs WHERE slug LIKE 'daily-english%' OR slug LIKE 'english-learning%' LIMIT 1",
          )
        ).rows[0]?.id ?? '30000000-0000-4000-8000-000000000001';
      const pack = (await packs.detail(scope, packId)).pack;
      const unit = await packs.lessonUnit(scope, pack.id),
        steps = buildUnitLearningPath(unit, [], []).steps.map((step) => step.key);
      await courses.saveUnitPathChoices(
        scope,
        pack.id,
        { revision: -1, eventId: randomUUID(), skipped: true },
        steps,
      );
      assert.equal((await reloaded.unitPathChoices(scope, pack.id)).skippedSteps.length, 9);
      assert.equal((await packs.detail(scope, pack.id)).pack.progress.pathSkipped, true);
      assert.equal((await packs.detail(other, pack.id)).pack.progress.pathSkipped, false);
      const migration = await import(
        new URL('../../migrations/1792620000000_learning-path-choices.js', import.meta.url).href
      );
      const sql: string[] = [];
      migration.down({ sql: (statement: string) => sql.push(statement) });
      await assert.rejects(db.adminPool.query(sql.join('\n')), /check constraint/);
    } finally {
      await db.dispose();
    }
  },
);
