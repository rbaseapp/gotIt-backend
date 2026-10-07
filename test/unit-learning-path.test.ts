import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildUnitLearningPath } from '../src/modules/word-packs/unit-learning-path.js';
import { PrivateLessonService } from '../src/modules/private-lessons/private-lesson.service.js';
import { CourseService } from '../src/modules/courses/course.service.js';
import {
  homeworkActionSchema,
  unitHomeworkContentSchema,
} from '../src/modules/courses/course.schemas.js';
import { AppError } from '../src/shared/errors/app-error.js';
import { currentWordStage } from '../src/modules/word-packs/teacher-stations.js';
import { privateLessonInputSchema } from '../src/modules/private-lessons/private-lesson.validation.js';
import {
  unitFixture,
  unitLesson,
  unitAssignment,
  unitHistoryFixture,
} from './helpers/unit-path-fixtures.js';
import {
  MemoryLearningStore,
  FixtureGenerator,
  profiles,
  scope,
  expandedHomeworkContent,
} from './helpers/course-fixtures.js';

test('words alone never skip the first teacher meeting', () => {
  const path = buildUnitLearningPath(unitFixture(), [], []);
  assert.deepEqual(
    path.stations.map((s) => s.available),
    [true, false, false],
  );
  assert.equal(path.nextAction.station, 'supported');
  assert.equal(path.stations[1]!.lockReason, 'previous_preparation');
});
test('requesting a future meeting directly is denied before a teacher call starts', async () => {
  let calls = 0;
  const fixture = unitHistoryFixture([]);
  const service = new PrivateLessonService({
    apiKey: 'fixture',
    model: 'fixture',
    voice: 'marin',
    transcriptionModel: 'fixture',
    profiles,
    vocabulary: { learned: async () => ({ items: [] }) },
    wordPacks: { lessonUnit: async () => unitFixture() },
    journal: fixture.journal,
    courses: fixture.courses,
    fetchImpl: async () => {
      calls++;
      return Response.json({ value: 'fixture' });
    },
  });
  await assert.rejects(
    service.createSession(
      scope,
      privateLessonInputSchema.parse({
        packId: unitFixture().packId,
        targetLanguageCode: 'en',
        station: 'review',
      }),
    ),
    { code: 'PRIVATE_LESSON_STATION_LOCKED' },
  );
  assert.equal(calls, 0);
});
test('meeting completion and its preparation are separate checkpoints', () => {
  const lesson = unitLesson(),
    assignment = unitAssignment(lesson);
  let path = buildUnitLearningPath(unitFixture(), [lesson], [assignment]);
  assert.equal(path.stations[0]!.meetingCompleted, true);
  assert.equal(path.stations[1]!.available, false);
  assert.equal(path.nextAction.kind, 'homework');
  assignment.progress.forEach((p) => {
    p.done = true;
  });
  path = buildUnitLearningPath(unitFixture(20), [lesson], [assignment]);
  assert.equal(path.nextAction.kind, 'words');
  assert.equal(path.stations[1]!.lockReason, 'words');
  path = buildUnitLearningPath(unitFixture(), [lesson], [assignment]);
  assert.equal(path.nextAction.station, 'midpoint');
  assert.equal(path.stations[2]!.available, false);
});
test('an interrupted or insufficient-evidence meeting does not count', () => {
  const lesson = unitLesson();
  lesson.report!.assessment.lessonPerformance.evidenceQuality = 'insufficient';
  assert.equal(
    buildUnitLearningPath(unitFixture(), [lesson], [unitAssignment(lesson, true)]).stations[0]!
      .meetingCompleted,
    false,
  );
  lesson.report!.assessment.lessonPerformance.evidenceQuality = 'moderate';
  lesson.status = 'summarizing';
  assert.equal(
    buildUnitLearningPath(unitFixture(), [lesson], []).stations[0]!.meetingCompleted,
    false,
  );
});
test('repeating a meeting keeps the original completed preparation and stage words', () => {
  const first = unitLesson(),
    repeat = unitLesson('supported', '2026-10-02T10:00:00.000Z');
  const unit = unitFixture();
  unit.stageWordsByStation = {
    midpoint: [
      {
        sourceText: 'today',
        translationText: 'היום',
        exampleText: null,
        introduced: true,
        learningItemId: null,
      },
    ],
  };
  const path = buildUnitLearningPath(
    unit,
    [repeat, first],
    [unitAssignment(repeat), unitAssignment(first, true)],
  );
  assert.equal(path.stations[0]!.lessonId, first.id);
  assert.equal(path.nextAction.station, 'midpoint');
  assert.equal(path.words[0]!.sourceText, 'today');
  assert.deepEqual(currentWordStage(50, 10), { start: 10, end: 25 });
});
test('future task URLs and repeat mode cannot advance an unfinished task', async () => {
  const lesson = unitLesson(),
    fixture = unitHistoryFixture([lesson]);
  const homework = unitAssignment(lesson);
  fixture.store.documents.set(fixture.store.key(scope, lesson.id), homework);
  for (const review of [false, true])
    await assert.rejects(
      fixture.courses.homeworkAction(
        scope,
        homework.id,
        homeworkActionSchema.parse({
          revision: 0,
          eventId: randomUUID(),
          taskIndex: 1,
          action: 'answer',
          answer: 'We are at home.',
          review,
        }),
      ),
      (error: unknown) => error instanceof AppError && error.statusCode === 409,
    );
});
test('review scoring is idempotent and never changes the original progress', async () => {
  const lesson = unitLesson(),
    fixture = unitHistoryFixture([lesson]);
  fixture.seed();
  const before = await fixture.courses.homework(scope, lesson.id);
  const command = homeworkActionSchema.parse({
    revision: 0,
    eventId: randomUUID(),
    taskIndex: 0,
    review: true,
    action: 'answer',
    answer: 'We are at home.',
  });
  const result = await fixture.courses.homeworkAction(scope, lesson.id, command);
  assert.equal(result.review?.result, 'correct');
  assert.equal(result.completedCount, before.progress.length);
  assert.deepEqual((await fixture.courses.homework(scope, lesson.id)).progress, before.progress);
  assert.deepEqual(await fixture.courses.homeworkAction(scope, lesson.id, command), result);
});
test('homework read, preparation and actions remain blocked until report completion', async () => {
  const lesson = unitLesson();
  lesson.status = 'summarizing';
  const fixture = unitHistoryFixture([lesson]);
  fixture.seed();
  const blocked = (error: unknown) =>
    error instanceof AppError && error.code === 'HOMEWORK_MEETING_REQUIRED';
  await assert.rejects(fixture.courses.homework(scope, lesson.id), blocked);
  await assert.rejects(
    fixture.courses.prepareHomework(scope, lesson.id, { revision: 0, eventId: randomUUID() }),
    blocked,
  );
  await assert.rejects(
    fixture.courses.homeworkAction(
      scope,
      lesson.id,
      homeworkActionSchema.parse({
        revision: 0,
        eventId: randomUUID(),
        taskIndex: 0,
        action: 'hint',
      }),
    ),
    blocked,
  );
});
test('unit homework generates a grounded short practice, while general homework retains its policy', async () => {
  const lesson = unitLesson(),
    store = new MemoryLearningStore(),
    ai = new FixtureGenerator();
  const content = expandedHomeworkContent();
  content.tasks = content.tasks.slice(0, 3);
  content.estimatedMinutes = 3;
  ai.handler = async (name) =>
    name === 'lesson_homework' ? content : { valid: true, feedback: 'Grounded' };
  const service = new CourseService(store, profiles, ai);
  await service.recordLesson(scope, lesson, lesson.report!, [
    { role: 'learner', text: 'I am at home.' },
    { role: 'tutor', text: 'I am at home.' },
  ]);
  const result = await service.prepareHomework(scope, lesson.id, {
    revision: 0,
    eventId: randomUUID(),
  });
  assert.equal(result.tasks.length, 3);
  assert.equal(result.estimatedMinutes, 3);
  assert.equal(unitHomeworkContentSchema.safeParse(content).success, true);
});
test('map fails closed on assignment-service errors instead of losing prerequisites', async () => {
  const lesson = unitLesson(),
    fixture = unitHistoryFixture([lesson]);
  fixture.courses.homework = async () => {
    throw new Error('database unavailable');
  };
  const service = new PrivateLessonService({
    model: 'fixture',
    voice: 'marin',
    transcriptionModel: 'fixture',
    profiles,
    vocabulary: { learned: async () => ({ items: [] }) },
    wordPacks: { lessonUnit: async () => unitFixture() },
    journal: fixture.journal,
    courses: fixture.courses,
  });
  await assert.rejects(
    service.getLearningMap(scope, lesson.wordPack!.packId),
    /database unavailable/,
  );
});
