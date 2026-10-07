import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestDatabase } from '../helpers/postgres.js';
import { unitLesson, unitAssignment } from '../helpers/unit-path-fixtures.js';
import { PostgresPrivateLessonJournal } from '../../src/modules/private-lessons/private-lesson.repository.js';
import { PostgresLearningDocumentStore } from '../../src/modules/courses/course.repository.js';
import { WordPackRepository } from '../../src/modules/word-packs/word-packs.repository.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import { PROFILE_DEFAULTS } from '../../src/modules/profile/profile.constants.js';
import { CourseService } from '../../src/modules/courses/course.service.js';
import { PrivateLessonService } from '../../src/modules/private-lessons/private-lesson.service.js';

test(
  'unit map prerequisites persist across services and whole-unit completion includes all three preparations',
  { timeout: 180000 },
  async () => {
    const database = await createTestDatabase();
    try {
      const scope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
      await database.adminPool.query(
        "INSERT INTO core.applications(id,key,name) VALUES($1,'unit-map-test','Unit map')",
        [scope.applicationId],
      );
      await database.adminPool.query(
        "INSERT INTO core.application_users(id,application_id,email) VALUES($1,$2,'map@example.test')",
        [scope.applicationUserId, scope.applicationId],
      );
      const profileRepo = new ProfileRepository(database.runtimePool);
      await profileRepo.ensureAndGet(scope, PROFILE_DEFAULTS);
      await database.adminPool.query(
        "UPDATE product_gotit.user_profiles SET default_source_language='en',default_translation_language='he' WHERE application_id=$1 AND application_user_id=$2",
        [scope.applicationId, scope.applicationUserId],
      );
      const packs = new WordPackRepository(database.runtimePool);
      const pack = (await packs.list(scope)).packs.find((pack) => pack.teacherStations.length > 0)!;
      assert.ok(pack);
      const detail = await packs.detail(scope, pack.id);
      await packs.setKnown(scope, pack.id, {
        entryIds: detail.entries.map((entry) => entry.id),
        known: true,
      });
      assert.equal(
        (await packs.detail(scope, pack.id)).pack.progress.unitCompleted,
        false,
        'words do not silently move to the next unit',
      );
      const journal = new PostgresPrivateLessonJournal(database.runtimePool),
        store = new PostgresLearningDocumentStore(database.runtimePool);
      const makeService = () =>
        new PrivateLessonService({
          model: 'fixture',
          voice: 'marin',
          transcriptionModel: 'fixture',
          profiles: new ProfileService(profileRepo),
          vocabulary: { learned: async () => ({ items: [] }) },
          mapWordPacks: packs,
          journal: new PostgresPrivateLessonJournal(database.runtimePool),
          courses: new CourseService(
            new PostgresLearningDocumentStore(database.runtimePool),
            new ProfileService(profileRepo),
            undefined,
            undefined,
            undefined,
            journal,
          ),
        });
      for (const [index, station] of (['supported', 'midpoint', 'review'] as const).entries()) {
        const lesson = unitLesson(station);
        lesson.wordPack = { ...(await packs.lessonUnit(scope, pack.id)), station };
        await journal.create(scope, lesson);
        await journal.complete(scope, lesson.id, lesson.report!);
        const homework = unitAssignment(lesson, true);
        await store.save(scope, homework, null, randomUUID(), `fixture-${lesson.id}`);
        const path = await makeService().getLearningMap(scope, pack.id);
        assert.equal(path.stations[index]!.preparationComplete, true);
        if (index < 2) assert.equal(path.nextAction.station, ['midpoint', 'review'][index]);
      }
      assert.equal((await packs.detail(scope, pack.id)).pack.progress.unitCompleted, true);
      assert.equal(
        (await makeService().getLearningMap(scope, pack.id)).stations.every(
          (station) => station.preparationComplete,
        ),
        true,
      );
      const stranger = { ...scope, applicationUserId: randomUUID() };
      assert.equal(
        (await makeService().getLearningMap(stranger, pack.id)).stations.some(
          (station) => station.meetingCompleted,
        ),
        false,
      );
    } finally {
      await database.dispose();
    }
  },
);
