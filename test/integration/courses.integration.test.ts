import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTestDatabase } from '../helpers/postgres.js';
import {
  courseFixture,
  homeworkFixture,
  preferences,
  plan,
  FixtureGenerator,
} from '../helpers/course-fixtures.js';
import { PROFILE_DEFAULTS } from '../../src/modules/profile/profile.constants.js';
import { ProfileRepository } from '../../src/modules/profile/profile.repository.js';
import { ProfileService } from '../../src/modules/profile/profile.service.js';
import {
  PostgresLearningDocumentStore,
  commandFingerprint,
} from '../../src/modules/courses/course.repository.js';
import { CourseService } from '../../src/modules/courses/course.service.js';
import { PostgresPrivateLessonJournal } from '../../src/modules/private-lessons/private-lesson.repository.js';
import { basicPrivateLessonReport } from '../../src/modules/private-lessons/private-lesson.summary.js';
import type { PrivateLessonPlan } from '../../src/modules/private-lessons/private-lesson.prompt.js';

test(
  'personal courses persist approvals, atomic command replay, scoped history and homework resume in PostgreSQL; migration rolls back',
  { timeout: 180000 },
  async () => {
    const database = await createTestDatabase();
    try {
      const scope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
      await database.adminPool.query(
        "INSERT INTO core.applications(id,key,name) VALUES($1,'courses-test','Courses test')",
        [scope.applicationId],
      );
      await database.adminPool.query(
        "INSERT INTO core.application_users(id,application_id,email) VALUES($1,$2,'courses@example.test')",
        [scope.applicationUserId, scope.applicationId],
      );
      const repository = new ProfileRepository(database.runtimePool);
      await repository.ensureAndGet(scope, PROFILE_DEFAULTS);
      const profiles = new ProfileService(repository),
        store = new PostgresLearningDocumentStore(database.runtimePool),
        service = new CourseService(store, profiles, new FixtureGenerator());
      const initial = courseFixture();
      await store.save(scope, initial, null, randomUUID(), 'create-course');
      const input = { revision: 0, eventId: randomUUID() };
      const simultaneous = await Promise.all([
        service.approvePreferences(scope, initial.id, input),
        service.approvePreferences(scope, initial.id, input),
      ]);
      assert.equal(simultaneous[0]!.revision, 1);
      assert.equal(simultaneous[1]!.revision, 1);
      const commands = await database.runtimePool.query(
        'SELECT count(*)::int AS count FROM product_gotit.learning_commands WHERE document_id=$1',
        [initial.id],
      );
      assert.equal(commands.rows[0]!.count, 2);
      const race = await Promise.allSettled([
        service.updatePreferences(scope, initial.id, {
          revision: 1,
          eventId: randomUUID(),
          preferences: { ...preferences, goal: 'first' },
        }),
        service.updatePreferences(scope, initial.id, {
          revision: 1,
          eventId: randomUUID(),
          preferences: { ...preferences, goal: 'second' },
        }),
      ]);
      assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
      let course = await service.course(scope, initial.id);
      course = {
        ...course,
        approvedPreferences: preferences,
        preferencesApprovedAt: new Date().toISOString(),
        activeVersion: 1,
        versions: [{ version: 1, preferences, plan, createdAt: course.createdAt }],
      };
      await store.save(scope, course, course.revision, randomUUID(), 'activate-fixture');
      const stranger = { ...scope, applicationUserId: randomUUID() };
      assert.equal(await store.get(stranger, initial.id), null);
      const lesson: PrivateLessonPlan = {
        id: randomUUID(),
        durationSeconds: 600,
        targetLanguageCode: 'en',
        supportLanguageCode: 'he',
        lessonMode: 'absolute_beginner',
        level: 'A1',
        topic: 'Introductions',
        grammarFocus: 'be',
        focusAreas: ['speaking', 'grammar'],
        customFocus: null,
        correctionMode: 'recast',
        vocabularyMode: 'none',
        teacherVoice: 'female',
        speechRate: 'slow',
        interests: [],
        targets: [],
        continuity: null,
        roadmap: null,
      };
      const prepared = await service.prepareLesson(scope, lesson, course.id);
      const journal = new PostgresPrivateLessonJournal(database.runtimePool);
      await journal.create(scope, prepared);
      const loaded = await journal.get(scope, lesson.id);
      assert.equal(loaded?.course?.courseId, course.id);
      assert.equal(loaded?.course?.objective, plan.units[0]!.lessons[0]!.objective);
      const report = basicPrivateLessonReport(prepared);
      report.grammarPoints = [
        { topic: 'be', explanation: 'Introducing yourself', example: 'I am at home.' },
      ];
      await service.recordLesson(scope, prepared, report, [
        { role: 'tutor', text: 'I am at home.' },
        { role: 'learner', text: 'I am at home.' },
      ]);
      await service.recordLesson(scope, prepared, report, [
        { role: 'tutor', text: 'I am at home.' },
        { role: 'learner', text: 'I am at home.' },
      ]);
      assert.equal((await service.course(scope, course.id)).evidence.length, 1);
      assert.equal((await service.course(scope, course.id)).evidence[0]!.independent, false);
      const preparedHomework = await service.prepareHomework(scope, lesson.id, {
        revision: 0,
        eventId: randomUUID(),
      });
      assert.equal(preparedHomework.tasks.length, 2);
      const draft = await service.homeworkAction(scope, lesson.id, {
        revision: preparedHomework.revision,
        eventId: randomUUID(),
        taskIndex: 0,
        action: 'draft',
        answer: 'We are',
        channel: 'text',
      });
      const freshService = new CourseService(
        new PostgresLearningDocumentStore(database.runtimePool),
        profiles,
        new FixtureGenerator(),
      );
      assert.equal((await freshService.homework(scope, lesson.id)).progress[0]!.draft, 'We are');
      assert.equal((await store.list(stranger, 'homework')).length, 0);
      const event = randomUUID(),
        bad = homeworkFixture();
      await assert.rejects(store.save(stranger, bad, null, event, commandFingerprint(bad)));
      assert.equal(
        await store.replay(stranger, event, commandFingerprint(bad)),
        null,
        'foreign-key failure rolls back receipt too',
      );
      assert.equal(draft.revision, 2);
      await database.migrate('down');
      const rolledBack = await database.adminPool.query(
        "SELECT to_regclass('product_gotit.learning_documents') AS relation",
      );
      assert.equal(rolledBack.rows[0]!.relation, null);
      await database.migrate();
      const reapplied = await database.adminPool.query(
        "SELECT to_regclass('product_gotit.learning_documents') AS relation",
      );
      assert.ok(reapplied.rows[0]!.relation);
    } finally {
      await database.dispose();
    }
  },
);
