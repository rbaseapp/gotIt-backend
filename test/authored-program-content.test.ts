import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { generatedCoursePlanSchema } from '../src/modules/courses/course.schemas.js';
import { lessonMaterialSchema } from '../src/modules/courses/lesson-material.schema.js';
import { unitLesson, unitHistoryFixture } from './helpers/unit-path-fixtures.js';
import { expandedHomeworkContent, scope } from './helpers/course-fixtures.js';
import { publicHomework } from '../src/modules/courses/course.service.js';
import { buildRealtimeLessonContract } from '../src/modules/private-lessons/private-lesson.realtime.js';

test('authored practice is assigned exactly once after actual learning and keeps solutions private', async () => {
  const lesson = unitLesson(),
    fixture = unitHistoryFixture([lesson]);
  const practice = expandedHomeworkContent();
  practice.tasks[0]!.expectedAnswer = 'PRIVATE_SOLUTION_MARKER';
  practice.tasks[0]!.acceptedAnswers = ['PRIVATE_SOLUTION_MARKER'];
  lesson.wordPack!.material = lessonMaterialSchema.parse({
    practice,
    readingPassage: 'Read this exact passage.',
    teacherInstructions: 'Ask a question about the passage.',
  });
  const turns = [
    { role: 'tutor' as const, text: 'I am at home.', atSeconds: 1 },
    { role: 'learner' as const, text: 'I am at home.', atSeconds: 2 },
  ];
  await fixture.courses.recordLesson(scope, lesson, lesson.report!, turns);
  const saved = await fixture.courses.homework(scope, lesson.id);
  assert.deepEqual(saved.content, practice);
  assert.equal(saved.progress.length, practice.tasks.length);
  assert.equal(publicHomework(saved).needsRefresh, false);
  assert.doesNotMatch(JSON.stringify(publicHomework(saved)), /PRIVATE_SOLUTION_MARKER/);
  const prepared = await fixture.courses.prepareHomework(scope, lesson.id, {
    eventId: crypto.randomUUID(),
    revision: 0,
  });
  assert.equal(prepared.taskCount, practice.tasks.length);
  await fixture.courses.recordLesson(scope, lesson, lesson.report!, turns);
  assert.equal((await fixture.courses.homework(scope, lesson.id)).revision, 0);
  const contract = buildRealtimeLessonContract(lesson, {
    model: 'fixture',
    transcriptionModel: 'fixture',
  });
  assert.match(contract.session.instructions, /Read this exact passage/);
  assert.doesNotMatch(JSON.stringify(contract), /PRIVATE_SOLUTION_MARKER/);
  assert.match(contract.events.opening.response.instructions, /Ask a question about the passage/);
});
test('authored material bounds and strict fields reject malformed tasks and hidden authority', () => {
  assert.equal(
    lessonMaterialSchema.safeParse({ readingPassage: 'x'.repeat(12001) }).success,
    false,
  );
  assert.equal(lessonMaterialSchema.safeParse({ score: 100 }).success, false);
  assert.equal(
    lessonMaterialSchema.safeParse({ practice: { ...expandedHomeworkContent(), tasks: [] } })
      .success,
    false,
  );
});
test('admin material does not add optional properties to the strict provider generation schema', () => {
  const schema = z.toJSONSchema(generatedCoursePlanSchema, { io: 'input' }) as any;
  const lesson = schema.properties.units.items.properties.lessons.items;
  assert.deepEqual(Object.keys(lesson.properties).sort(), ['objective', 'title']);
  assert.deepEqual(lesson.required.sort(), ['objective', 'title']);
});
