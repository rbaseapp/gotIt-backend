import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AdaptiveLessonPlanner,
  adaptivePlanIssues,
} from '../src/modules/private-lessons/private-lesson.planner.js';
import { lessonMaterialSchema } from '../src/modules/courses/lesson-material.schema.js';
import {
  authoringPlan,
  reviewAuthoredMaterial,
  authoringRequestSchema,
} from '../src/modules/admin/admin.authoring.js';
import { adaptiveLesson, adaptiveCurriculum } from './helpers/adaptive-lesson-fixtures.js';
import {
  scope,
  MemoryLearningStore,
  FixtureGenerator,
  profiles,
} from './helpers/course-fixtures.js';
import { CourseService } from '../src/modules/courses/course.service.js';
import { basicPrivateLessonReport } from '../src/modules/private-lessons/private-lesson.summary.js';
import { readingHash, unitReadingSchema } from '../src/modules/word-packs/unit-reading.js';
import { courseFixture, plan as coursePlan, preferences } from './helpers/course-fixtures.js';

const context = {
  title: 'Travel',
  objective: 'Ask for directions',
  targetLanguageCode: 'en',
  supportLanguageCode: 'he',
  level: 'A2' as const,
  durationMinutes: 5,
  words: [],
  ageGroup: 'adult' as const,
  literacy: 'independent' as const,
};
test('exact authored teaching uses the approved questions without regenerating or changing their order', async () => {
  const plan = adaptiveLesson(300),
    curriculum = adaptiveCurriculum(plan);
  const material = lessonMaterialSchema.parse({
    adaptationPolicy: 'authored_only',
    teachingPlan: curriculum,
  });
  const prepared = authoringPlan(context, material);
  let called = false;
  const planner = new AdaptiveLessonPlanner({
    generate: async () => {
      called = true;
      throw new Error('should not generate approved content');
    },
  });
  assert.deepEqual(await planner.prepare(scope, prepared, 'guided'), curriculum);
  assert.equal(called, false);
  assert.equal(reviewAuthoredMaterial(context, material).readiness.needsRuntimePlanning, false);
  const reordered = structuredClone(curriculum);
  [reordered.activities[0], reordered.activities[1]] = [
    reordered.activities[1]!,
    reordered.activities[0]!,
  ];
  assert.ok(adaptivePlanIssues(prepared, reordered).some((issue) => issue.includes('order')));
  const rewritten = structuredClone(curriculum);
  rewritten.activities[0]!.prompt = 'Ask something different.';
  assert.ok(adaptivePlanIssues(prepared, rewritten).some((issue) => issue.includes('preserved')));
});
test('material validates homework links and private answers, preserving optional legacy content', () => {
  assert.ok(lessonMaterialSchema.safeParse({}).success);
  const curriculum = adaptiveCurriculum(adaptiveLesson(300));
  const task = {
    kind: 'choice',
    objective: 'Directions',
    sourceActivityId: curriculum.activities[0]!.id,
    prompt: 'Choose: left or right?',
    sourceQuote: 'Turn left.',
    choices: ['left', 'right'],
    tokens: [],
    listeningText: null,
    hint: 'Think of the direction.',
    explanation: 'Turn left is the model.',
    expectedAnswer: 'left',
    acceptedAnswers: ['left'],
  };
  const material = {
    teachingPlan: curriculum,
    practice: {
      title: 'Practice',
      objective: 'Directions',
      estimatedMinutes: 3,
      tasks: [task, task, task],
    },
  };
  assert.ok(lessonMaterialSchema.safeParse(material).success);
  assert.equal(
    lessonMaterialSchema.safeParse({
      ...material,
      practice: {
        ...material.practice,
        tasks: [{ ...task, sourceActivityId: 'other-lesson' }, task, task],
      },
    }).success,
    false,
  );
  assert.equal(
    lessonMaterialSchema.safeParse({
      ...material,
      practice: {
        ...material.practice,
        tasks: [{ ...task, expectedAnswer: 'missing' }, task, task],
      },
    }).success,
    false,
  );
  const child = authoringPlan(
    { ...context, ageGroup: 'child', literacy: 'not_yet' },
    lessonMaterialSchema.parse({}),
  );
  assert.equal(child.course?.preferences.ageGroup, 'child');
  assert.equal(child.course?.preferences.literacy, 'not_yet');
  assert.equal(
    authoringRequestSchema.safeParse({
      operationId: crypto.randomUUID(),
      reason: 'test',
      action: 'validate',
      context,
      material: {},
      applicationId: 'forged',
    }).success,
    false,
  );
});
test('adaptive homework includes only authored questions linked to activities actually performed', async () => {
  const store = new MemoryLearningStore(),
    service = new CourseService(store, profiles, new FixtureGenerator());
  const plan = adaptiveLesson(300),
    curriculum = adaptiveCurriculum(plan);
  const task = {
    kind: 'response' as const,
    objective: 'Directions',
    prompt: 'Ask where the station is.',
    sourceQuote: 'Where is the station?',
    choices: [],
    tokens: [],
    listeningText: null,
    hint: 'Ask where.',
    explanation: 'Use a where question.',
    expectedAnswer: 'Where is the station?',
    acceptedAnswers: ['Where is the station?'],
  };
  const material = lessonMaterialSchema.parse({
    teachingPlan: curriculum,
    practice: {
      title: 'Practice',
      objective: 'Directions',
      estimatedMinutes: 3,
      tasks: curriculum.activities
        .slice(0, 5)
        .map((activity) => ({ ...task, sourceActivityId: activity.id })),
    },
  });
  plan.wordPack = authoringPlan(context, material).wordPack;
  // No vocabulary restriction is needed for this fixture, but recordLesson resolves authored material from this actual lesson context.
  plan.course = { ...authoringPlan(context, material).course! };
  const course = await service.start(scope, {
    eventId: crypto.randomUUID(),
    targetLanguageCode: 'en',
    supportLanguageCode: 'he',
  });
  plan.course.courseId = course.id;
  plan.learningEvidence = curriculum.activities.slice(0, 3).map((activity) => ({
    activityId: activity.id,
    family: activity.family,
    outcome: 'assisted',
    attempts: 1,
  }));
  const report = basicPrivateLessonReport(plan);
  report.grammarPoints = [
    { topic: 'Questions', explanation: 'Ask for information.', example: 'Where is the station?' },
  ];
  await service.recordLesson(scope, plan, report, [
    { role: 'tutor', text: 'Where is the station?' },
    { role: 'learner', text: 'Where is the station?' },
  ]);
  const homework = await service.homework(scope, plan.id);
  assert.equal(homework.content?.tasks.length, 3);
  assert.deepEqual(
    homework.progress.map((item) => item.done),
    [false, false, false],
  );
});
test('reading revisions invalidate completion fingerprints and reject duplicate/unbounded step data', () => {
  const reading = unitReadingSchema.parse({
    id: 'intro',
    title: 'A greeting',
    passage: 'Hello, Maya.',
    after: 'supported:meeting',
    estimatedMinutes: 2,
    questions: ['Who is greeted?'],
  });
  assert.equal(readingHash(reading), readingHash(structuredClone(reading)));
  assert.notEqual(readingHash(reading), readingHash({ ...reading, passage: 'Hello, Alex.' }));
  assert.equal(unitReadingSchema.safeParse({ ...reading, after: 'future-unit' }).success, false);
});
test('an authored lesson duration reaches the actual course lesson without changing other lessons', async () => {
  const store = new MemoryLearningStore();
  const course = courseFixture();
  const curriculum = structuredClone(coursePlan);
  curriculum.units[0]!.lessons[0]!.durationMinutes = 7;
  course.versions = [
    { version: 1, preferences, plan: curriculum, createdAt: new Date().toISOString() },
  ];
  course.activeVersion = 1;
  store.seed(course);
  const service = new CourseService(store, profiles, new FixtureGenerator());
  const context = await service.lessonContext(scope, course.id);
  assert.equal(context.durationMinutes, 7);
  const prepared = await service.prepareLesson(scope, adaptiveLesson(), course.id, context);
  assert.equal(prepared.durationSeconds, 420);
  assert.equal(curriculum.units[0]!.lessons[1]!.durationMinutes, undefined);
});
