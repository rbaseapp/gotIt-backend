import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { CourseService, publicCourse } from '../src/modules/courses/course.service.js';
import {
  courseFixture,
  plan,
  profiles,
  scope,
  MemoryLearningStore,
} from './helpers/course-fixtures.js';
import { buildUnitLearningPath } from '../src/modules/word-packs/unit-learning-path.js';
import { emptyUnitPathChoices } from '../src/modules/word-packs/unit-path-choices.js';
import { unitFixture, unitLesson, unitAssignment } from './helpers/unit-path-fixtures.js';

test('personal course skips are reversible, version-scoped and never manufacture evidence', async () => {
  const store = new MemoryLearningStore(),
    service = new CourseService(store, profiles);
  const course = courseFixture();
  course.activeVersion = 1;
  course.versions = [
    {
      version: 1,
      preferences: course.preferences,
      plan: structuredClone(plan),
      createdAt: course.createdAt,
    },
  ];
  course.evidence = [
    {
      lessonId: randomUUID(),
      unitKey: 'foundation',
      lessonIndex: 0,
      version: 1,
      covered: true,
      independent: true,
      recordedAt: course.createdAt,
    },
  ];
  store.seed(course);
  const input = {
    revision: 0,
    eventId: randomUUID(),
    version: 1,
    unitKey: 'foundation',
    skipped: true,
  };
  const skipped = await service.pathChoice(scope, course.id, input);
  assert.equal(skipped.nextLesson?.unitKey, 'intermediate');
  assert.equal(skipped.skippedLessons.length, 1);
  assert.equal(skipped.progress.demonstrated, 1);
  assert.deepEqual(skipped.evidence, course.evidence);
  assert.deepEqual(await service.pathChoice(scope, course.id, input), skipped);
  await assert.rejects(service.pathChoice(scope, course.id, { ...input, skipped: false }), {
    code: 'COURSE_CHANGED',
  });
  const selected = await service.lessonContext(scope, course.id, {
    version: 1,
    unitKey: 'advanced',
    lessonIndex: 1,
  });
  assert.equal(selected.lessonTitle, plan.units[2]!.lessons[1]!.title);
  assert.equal((await service.course(scope, course.id)).revision, 1, 'selection is read-only');
  await assert.rejects(
    service.lessonContext(scope, course.id, { version: 2, unitKey: 'advanced', lessonIndex: 1 }),
    { code: 'COURSE_CHANGED' },
  );
  await assert.rejects(
    service.pathChoice({ ...scope, applicationUserId: randomUUID() }, course.id, {
      ...input,
      eventId: randomUUID(),
    }),
    { code: 'COURSE_NOT_FOUND' },
  );
  const restored = await service.pathChoice(scope, course.id, {
    ...input,
    revision: 1,
    eventId: randomUUID(),
    skipped: false,
  });
  assert.equal(restored.nextLesson?.lessonIndex, 1);
  assert.equal(restored.skippedLessons.length, 0);
  const changed = structuredClone(await service.course(scope, course.id));
  changed.skippedLessons = [{ version: 1, unitKey: 'foundation', lessonIndex: 1 }];
  changed.activeVersion = 2;
  const version = structuredClone(changed.versions[0]!);
  version.version = 2;
  version.plan.units[0]!.lessons[1]!.objective = 'Changed objective';
  changed.versions.push(version);
  assert.equal(publicCourse(changed).skippedLessons.length, 0);
  assert.equal(publicCourse(changed).nextLesson?.unitKey, 'foundation');
});

test('prepared unit choices preserve completed meetings, homework and word evidence', async () => {
  const store = new MemoryLearningStore(),
    service = new CourseService(store, profiles);
  const unit = unitFixture(0),
    choices = emptyUnitPathChoices(unit.packId);
  const input = { revision: -1, eventId: randomUUID(), skipped: true };
  const saved = await service.saveUnitPathChoices(
    scope,
    unit.packId,
    input,
    buildUnitLearningPath(unit, [], []).steps.map((step) => step.key),
  );
  const path = buildUnitLearningPath(unit, [], [], saved);
  assert.equal(path.navigationComplete, true);
  assert.equal(path.skippedSteps, 9);
  assert.equal(
    path.stations.some((station) => station.meetingCompleted || station.preparationComplete),
    false,
  );
  assert.equal(unit.introduced, 0);
  assert.deepEqual(await service.saveUnitPathChoices(scope, unit.packId, input, []), saved);
  await assert.rejects(
    service.saveUnitPathChoices(scope, unit.packId, { ...input, eventId: randomUUID() }, []),
    { code: 'COURSE_CHANGED' },
  );
  const restored = await service.saveUnitPathChoices(
    scope,
    unit.packId,
    { revision: 0, eventId: randomUUID(), skipped: false },
    path.steps.map((step) => step.key),
  );
  assert.equal(buildUnitLearningPath(unit, [], [], restored).navigationComplete, false);
  const lesson = unitLesson(),
    homework = unitAssignment(lesson, true);
  const history = buildUnitLearningPath(unit, [lesson], [homework], saved);
  assert.equal(history.stations[0]!.meetingCompleted, true);
  assert.equal(history.stations[0]!.preparationComplete, true);
  assert.equal(history.steps.find((step) => step.key === 'supported:meeting')?.skipped, false);
  assert.equal(choices.revision, -1);
});
