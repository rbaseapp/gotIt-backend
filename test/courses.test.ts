import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { CourseService, publicHomework } from '../src/modules/courses/course.service.js';
import { OpenAiCourseGenerator } from '../src/modules/courses/course.provider.js';
import { intakeReplySchema } from '../src/modules/courses/course.schemas.js';
import {
  nextCourseLesson,
  syllabusFor,
  validateCoursePlan,
} from '../src/modules/courses/course.curriculum.js';
import {
  MemoryLearningStore,
  FixtureGenerator,
  courseFixture,
  homeworkFixture,
  scope,
  preferences,
  plan,
  profiles,
} from './helpers/course-fixtures.js';
import { AppError } from '../src/shared/errors/app-error.js';
import request from 'supertest';
import pino from 'pino';
import { createApp } from '../src/app.js';
import { CoreAuthClient } from '../src/shared/core/core-auth.client.js';
import { API_ROUTES } from '../src/shared/http/api-catalog.js';
import { basicPrivateLessonReport } from '../src/modules/private-lessons/private-lesson.summary.js';
import type { PrivateLessonPlan } from '../src/modules/private-lessons/private-lesson.prompt.js';

const command = (revision: number) => ({ revision, eventId: randomUUID() });
const setup = () => {
  const store = new MemoryLearningStore(),
    ai = new FixtureGenerator();
  return { store, ai, service: new CourseService(store, profiles, ai) };
};
const conflict = (error: unknown) => error instanceof AppError && error.statusCode === 409;

test('course requires two explicit approvals; a preview cannot start a lesson', async () => {
  const { store, service } = setup();
  const course = courseFixture();
  store.seed(course);
  await assert.rejects(service.plan(scope, course.id, command(0)), conflict);
  const approved = await service.approvePreferences(scope, course.id, command(0));
  assert.equal(approved.activeVersion, null);
  const preview = await service.plan(scope, course.id, command(approved.revision));
  assert.equal(preview.versions[0]?.plan.units.length, 3);
  assert.equal(preview.activeVersion, null);
  await assert.rejects(service.lessonContext(scope, course.id), conflict);
  await assert.rejects(
    service.activate(scope, course.id, { ...command(preview.revision), version: 99 }),
    conflict,
  );
  const active = await service.activate(scope, course.id, {
    ...command(preview.revision),
    version: preview.draftVersion!,
  });
  assert.equal(active.nextLesson?.unitKey, 'foundation');
});
test('preference edits invalidate approval; stale generation cannot overwrite newer preferences', async () => {
  const { store, service, ai } = setup();
  const course = courseFixture();
  store.seed(course);
  const approved = await service.approvePreferences(scope, course.id, command(0));
  let release!: (value: unknown) => void;
  ai.handler = async () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const building = service.plan(scope, course.id, command(approved.revision));
  await new Promise((resolve) => setImmediate(resolve));
  const edited = await service.updatePreferences(scope, course.id, {
    ...command(approved.revision),
    preferences: { ...preferences, goal: 'מטרה חדשה' },
  });
  release(plan);
  await assert.rejects(building, conflict);
  assert.equal(edited.approvedPreferences, null);
  assert.equal((await service.course(scope, course.id)).preferences.goal, 'מטרה חדשה');
});
test('commands replay without another provider call and reject reusing a key for other content', async () => {
  const { store, service, ai } = setup();
  const course = courseFixture();
  store.seed(course);
  const input = {
    ...command(0),
    message: 'רוצה לדבר בטיול',
    channel: 'voice' as const,
    mode: 'preferences' as const,
  };
  const first = await service.turn(scope, course.id, input);
  const second = await service.turn(scope, course.id, input);
  assert.equal(first.revision, second.revision);
  assert.equal(ai.calls.length, 1);
  await assert.rejects(service.turn(scope, course.id, { ...input, message: 'משהו אחר' }), conflict);
});
test('course and homework access is isolated by application AND user', async () => {
  const { store, service } = setup();
  const course = courseFixture(),
    homework = homeworkFixture();
  store.seed(course);
  store.seed(homework);
  for (const stranger of [
    { ...scope, applicationId: randomUUID() },
    { ...scope, applicationUserId: randomUUID() },
  ]) {
    await assert.rejects(
      service.course(stranger, course.id),
      (err: unknown) => err instanceof AppError && err.statusCode === 404,
    );
    await assert.rejects(service.homework(stranger, homework.id));
    assert.deepEqual((await service.list(stranger)).courses, []);
  }
});
test('curricula are language specific; plan validation rejects omissions, forward dependencies and changes to learned units', () => {
  assert.match(syllabusFor(preferences).topics[0]!.title, /pronouns/);
  assert.match(
    syllabusFor({ ...preferences, targetLanguageCode: 'de' }).topics[0]!.title,
    /Verbzweit/,
  );
  assert.equal(syllabusFor({ ...preferences, targetLanguageCode: 'ja' }).basis, 'generated_scope');
  const missing = structuredClone(plan);
  missing.units[0]!.syllabusKeys = [];
  assert.throws(() => validateCoursePlan(missing, preferences));
  const invalid = structuredClone(plan);
  invalid.units[0]!.prerequisites = ['advanced'];
  assert.throws(() => validateCoursePlan(invalid, preferences));
  const course = courseFixture();
  course.activeVersion = 1;
  course.versions = [{ version: 1, preferences, plan, createdAt: course.createdAt }];
  course.evidence = [
    {
      lessonId: randomUUID(),
      unitKey: 'foundation',
      lessonIndex: 0,
      version: 1,
      covered: true,
      independent: false,
      recordedAt: course.createdAt,
    },
  ];
  const changed = structuredClone(plan);
  changed.units[0]!.outcome = 'different';
  assert.throws(() => validateCoursePlan(changed, preferences, course));
  assert.equal(nextCourseLesson(course)?.lessonIndex, 0, 'coverage alone does not advance');
  course.evidence[0]!.independent = true;
  assert.equal(nextCourseLesson(course)?.lessonIndex, 1);
});
test('homework hides private answers, accepts contractions and records independent first production', async () => {
  const { store, service } = setup();
  const homework = homeworkFixture();
  store.seed(homework);
  const publicJson = JSON.stringify(publicHomework(homework));
  assert.equal(publicJson.includes('acceptedAnswers'), false);
  assert.equal(publicJson.includes('expectedAnswer'), false);
  assert.equal(publicHomework(homework).tasks[0]?.solution, null);
  const result = await service.homeworkAction(scope, homework.id, {
    ...command(0),
    taskIndex: 0,
    action: 'answer',
    answer: "We're at home.",
    channel: 'text',
  });
  assert.equal(result.tasks[0]?.attempts[0]?.independent, true);
  assert.equal(result.tasks[0]?.done, true);
  assert.equal(result.tasks[1]?.solution, null, 'future task remains private');
});
test('hints persist across resume, assisted answers do not become independent evidence, and future tasks cannot be submitted', async () => {
  const { store, service } = setup();
  const homework = homeworkFixture();
  store.seed(homework);
  await assert.rejects(
    service.homeworkAction(scope, homework.id, {
      ...command(0),
      taskIndex: 1,
      action: 'answer',
      answer: 'We are at home.',
      channel: 'text',
    }),
    conflict,
  );
  const hint = await service.homeworkAction(scope, homework.id, {
    ...command(0),
    taskIndex: 0,
    action: 'hint',
    answer: '',
    channel: 'text',
  });
  assert.equal(
    publicHomework(await service.homework(scope, homework.id)).tasks[0]?.hint,
    hint.tasks[0]?.hint,
  );
  const answer = await service.homeworkAction(scope, homework.id, {
    ...command(hint.revision),
    taskIndex: 0,
    action: 'answer',
    answer: 'We are at home.',
    channel: 'voice',
  });
  assert.equal(answer.tasks[0]?.attempts[0]?.independent, false);
});
test('homework allows one retry then reveals an example; replay and skip cannot award progress twice', async () => {
  const { store, service } = setup();
  const homework = homeworkFixture();
  store.seed(homework);
  const input = {
    ...command(0),
    taskIndex: 0,
    action: 'answer' as const,
    answer: 'We is home',
    channel: 'text' as const,
  };
  const first = await service.homeworkAction(scope, homework.id, input);
  const replay = await service.homeworkAction(scope, homework.id, input);
  assert.equal(replay.tasks[0]?.attempts.length, 1);
  assert.equal(first.tasks[0]?.solution, null);
  const second = await service.homeworkAction(scope, homework.id, {
    ...input,
    ...command(first.revision),
  });
  assert.equal(second.tasks[0]?.done, true);
  assert.ok(second.tasks[0]?.solution);
  const skip = await service.homeworkAction(scope, homework.id, {
    ...command(second.revision),
    taskIndex: 1,
    action: 'skip',
    answer: '',
    channel: 'text',
  });
  assert.equal(skip.status, 'completed');
  assert.equal(skip.tasks[1]?.attempts[0]?.independent, false);
});
test('provider failure and uncertain feedback do not consume a scored try', async () => {
  const { store, service, ai } = setup();
  const homework = homeworkFixture();
  store.seed(homework);
  ai.handler = async () => {
    throw new Error('provider offline');
  };
  const input = {
    ...command(0),
    taskIndex: 0,
    action: 'answer' as const,
    answer: 'something unclear',
    channel: 'voice' as const,
  };
  await assert.rejects(service.homeworkAction(scope, homework.id, input));
  assert.equal((await service.homework(scope, homework.id)).revision, 0);
  ai.handler = async () => ({ result: 'uncertain', feedback: 'Could you clarify?' });
  const uncertain = await service.homeworkAction(scope, homework.id, input);
  assert.equal(uncertain.tasks[0]?.done, false);
  const good = await service.homeworkAction(scope, homework.id, {
    ...input,
    ...command(uncertain.revision),
    answer: 'We are at home.',
  });
  assert.equal(good.tasks[0]?.attempts.at(-1)?.independent, true);
});
test('generated homework must cite actual lesson evidence', async () => {
  const { store, service, ai } = setup();
  const homework = homeworkFixture();
  homework.content = null;
  homework.progress = [];
  store.seed(homework);
  ai.handler = async () => {
    const content = homeworkFixture().content!;
    content.tasks[0]!.sourceQuote = 'This was never taught';
    return content;
  };
  await assert.rejects(service.prepareHomework(scope, homework.id, command(0)));
  assert.equal((await service.homework(scope, homework.id)).content, null);
});
test('structured provider serializes transformed language schemas and rejects refusal/incomplete output', async () => {
  let calls = 0;
  const provider = new OpenAiCourseGenerator(
    'test-key',
    'configured-model',
    'configured-transcriber',
    async (_url, options) => {
      calls++;
      const body = JSON.parse(String(options?.body));
      assert.equal(body.store, false);
      assert.equal(body.model, 'configured-model');
      assert.equal(body.text.format.strict, true);
      assert.equal(
        body.text.format.schema.properties.preferences.properties.targetLanguageCode.type,
        'string',
      );
      return Response.json({
        status: 'completed',
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  message: 'שלום',
                  suggestions: [],
                  ready: false,
                  preferences,
                }),
              },
            ],
          },
        ],
      });
    },
  );
  const reply = await provider.generate(
    scope,
    intakeReplySchema,
    'course_intake',
    'Ask one question',
    {},
  );
  assert.equal(reply.preferences.targetLanguageCode, 'en');
  assert.equal(calls, 1);
  const refused = new OpenAiCourseGenerator(
    'test-key',
    'configured-model',
    'configured-transcriber',
    async () =>
      Response.json({ status: 'completed', output: [{ content: [{ type: 'refusal' }] }] }),
  );
  await assert.rejects(
    refused.generate(scope, intakeReplySchema, 'course_intake', '', {}),
    (err: unknown) => err instanceof AppError && err.code === 'COURSE_AI_UNAVAILABLE',
  );
});

test('a requested pace change requires preference approval again while the previous active course remains usable', async () => {
  const { store, service, ai } = setup();
  const course = courseFixture();
  Object.assign(course, {
    approvedPreferences: preferences,
    preferencesApprovedAt: course.createdAt,
    activeVersion: 1,
    versions: [{ version: 1, preferences, plan, createdAt: course.createdAt }],
  });
  store.seed(course);
  ai.handler = async () => ({
    message: 'נקצר את השיעורים',
    suggestions: [],
    ready: true,
    preferences: { ...preferences, minutesPerLesson: 5 },
  });
  const changed = await service.turn(scope, course.id, {
    ...command(0),
    mode: 'plan',
    channel: 'text',
    message: 'רק חמש דקות לשיעור',
  });
  assert.equal(changed.approvedPreferences, null);
  assert.equal(changed.activeVersion, 1);
  assert.equal(changed.pendingPlanChange, 'רק חמש דקות לשיעור');
  await assert.rejects(service.plan(scope, course.id, command(changed.revision)), conflict);
  assert.equal((await service.lessonContext(scope, course.id)).preferences.minutesPerLesson, 10);
  const approved = await service.approvePreferences(scope, course.id, command(changed.revision));
  ai.handler = async (_name, data) => {
    assert.equal((data as { requestedChange: string }).requestedChange, changed.pendingPlanChange);
    return plan;
  };
  const draft = await service.plan(scope, course.id, command(approved.revision));
  assert.equal(draft.draftVersion, 2);
  assert.equal(draft.activeVersion, 1);
  assert.equal(draft.pendingPlanChange, undefined);
});

test('a late result for replaced future content cannot advance a revised course', () => {
  const course = courseFixture(),
    revised = structuredClone(plan);
  revised.units[0]!.lessons[0]!.objective = 'Different skill';
  course.activeVersion = 2;
  course.versions = [
    { version: 1, preferences, plan, createdAt: course.createdAt },
    { version: 2, preferences, plan: revised, createdAt: course.createdAt },
  ];
  course.evidence = [
    {
      lessonId: randomUUID(),
      version: 1,
      unitKey: 'foundation',
      lessonIndex: 0,
      independent: true,
      covered: true,
      recordedAt: course.createdAt,
    },
  ];
  assert.equal(nextCourseLesson(course)?.lessonIndex, 0);
});

test('an interrupted greeting does not fabricate homework or course progress', async () => {
  const { service, store } = setup();
  const lesson: PrivateLessonPlan = {
    id: randomUUID(),
    durationSeconds: 600,
    targetLanguageCode: 'en',
    supportLanguageCode: 'he',
    lessonMode: 'absolute_beginner',
    level: 'A1',
    topic: 'Introductions',
    grammarFocus: 'be',
    focusAreas: ['speaking'],
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
  await service.recordLesson(scope, lesson, basicPrivateLessonReport(lesson), [
    { role: 'tutor', text: 'Hello!' },
    { role: 'learner', text: 'Hello' },
  ]);
  assert.equal(await store.get(scope, lesson.id), null);
});

test('course HTTP routes enforce Core identity, entitlement, strict input and private answers', async () => {
  const { store, service } = setup();
  const course = courseFixture(),
    homework = homeworkFixture();
  store.seed(course);
  store.seed(homework);
  let allowed = false;
  const coreAuthClient = new CoreAuthClient({
    baseUrl: 'https://core.example.test',
    applicationKey: 'gotit',
    timeoutMs: 1000,
    fetchImpl: async (url) =>
      Response.json(
        String(url).endsWith('/auth/me')
          ? {
              user: {
                id: scope.applicationUserId,
                applicationId: scope.applicationId,
                email: 'test@example.test',
              },
            }
          : {
              tier: allowed ? 'paid' : 'free',
              access: allowed,
              plan: { key: 'test', name: 'Test', kind: allowed ? 'paid' : 'free' },
              entitlements: allowed ? ['practice.play'] : [],
              subscription: null,
              trial: null,
            },
      ),
  });
  const app = createApp({
    logger: pino({ enabled: false }),
    coreAuthClient,
    checkDatabase: async () => {},
    profileService: profiles,
    courseService: service,
    enforcePaidEntitlements: true,
  });
  await request(app).get('/api/v1/courses').expect(401);
  await request(app).get('/api/v1/courses').set('Authorization', 'Bearer fixture').expect(402);
  allowed = true;
  const response = await request(app)
    .get(`/api/v1/courses/homework/${homework.id}`)
    .set('Authorization', 'Bearer fixture')
    .expect(200);
  assert.ok(response.headers['x-request-id']);
  assert.equal(response.body.homework.tasks[0].solution, null);
  await request(app)
    .post(`/api/v1/courses/homework/${homework.id}/actions`)
    .set('Authorization', 'Bearer fixture')
    .send({
      ...command(0),
      taskIndex: 0,
      action: 'answer',
      answer: 'We are at home.',
      channel: 'text',
      score: 100,
      applicationUserId: randomUUID(),
    })
    .expect(400);
  assert.equal((await service.homework(scope, homework.id)).revision, 0);
  assert.equal(API_ROUTES.filter(({ path }) => path.startsWith('/api/v1/courses')).length, 12);
  assert.equal(new Set(API_ROUTES.map(({ method, path }) => `${method} ${path}`)).size, API_ROUTES.length);
  assert.equal(API_ROUTES.length, 68);
});
