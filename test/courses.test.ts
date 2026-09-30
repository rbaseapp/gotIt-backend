import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  CourseService,
  publicCourse,
  publicHomework,
} from '../src/modules/courses/course.service.js';
import { OpenAiCourseGenerator } from '../src/modules/courses/course.provider.js';
import { homeworkContentSchema, intakeReplySchema } from '../src/modules/courses/course.schemas.js';
import {
  nextCourseLesson,
  syllabusFor,
  validateCoursePlan,
} from '../src/modules/courses/course.curriculum.js';
import {
  MemoryLearningStore,
  FixtureGenerator,
  courseFixture,
  expandedHomeworkContent,
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
import { PrivateLessonService } from '../src/modules/private-lessons/private-lesson.service.js';
import { privateLessonInputSchema } from '../src/modules/private-lessons/private-lesson.validation.js';

const command = (revision: number) => ({ revision, eventId: randomUUID() });
const setup = () => {
  const store = new MemoryLearningStore(),
    ai = new FixtureGenerator();
  return { store, ai, service: new CourseService(store, profiles, ai) };
};
const conflict = (error: unknown) => error instanceof AppError && error.statusCode === 409;

test('deleting a course removes only its own course and homework documents', async () => {
  const { store, service } = setup();
  const target = courseFixture();
  const other = { ...courseFixture(), id: randomUUID() };
  const linked = {
    ...homeworkFixture(),
    course: { courseId: target.id } as NonNullable<ReturnType<typeof homeworkFixture>['course']>,
  };
  const retained = {
    ...homeworkFixture(),
    course: { courseId: other.id } as NonNullable<ReturnType<typeof homeworkFixture>['course']>,
  };
  for (const document of [target, other, linked, retained]) store.seed(document);
  const stranger = { ...scope, applicationUserId: randomUUID() };
  await assert.rejects(
    () => service.deleteCourse(stranger, target.id),
    (error: unknown) => error instanceof AppError && error.statusCode === 404,
  );
  assert.ok(await store.get(scope, target.id));
  await service.deleteCourse(scope, target.id);
  assert.equal(await store.get(scope, target.id), null);
  assert.equal(await store.get(scope, linked.id), null);
  assert.ok(await store.get(scope, other.id));
  assert.ok(await store.get(scope, retained.id));
  await assert.rejects(
    () => service.deleteCourse(scope, target.id),
    (error: unknown) => error instanceof AppError && error.statusCode === 404,
  );
});

test('live course interview uses lesson Realtime model with automatic speech turns and no autonomous replies', async () => {
  const store = new MemoryLearningStore();
  const course = courseFixture();
  course.ready = false;
  course.approvedPreferences = null;
  course.messages = [{ role: 'tutor', text: 'מה תרצה ללמוד?', channel: 'text' }];
  store.seed(course);
  let requestBody:
    | {
        session: {
          model: string;
          audio: {
            input: { turn_detection: unknown };
            output: { voice: string };
          };
        };
      }
    | undefined;
  const service = new CourseService(store, profiles, new FixtureGenerator(), {
    apiKey: 'server-secret',
    model: 'gpt-realtime-2.1',
    transcriptionModel: 'gpt-4o-mini-transcribe',
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ value: 'ephemeral-secret' }), { status: 200 });
    },
  });
  const realtime = await service.realtimeSession(scope, course.id);
  assert.equal(realtime.clientSecret, 'ephemeral-secret');
  assert.equal(requestBody?.session.model, 'gpt-realtime-2.1');
  assert.deepEqual(requestBody?.session.audio.input.turn_detection, {
    type: 'server_vad',
    threshold: 0.7,
    prefix_padding_ms: 400,
    silence_duration_ms: 700,
    create_response: false,
    interrupt_response: true,
  });
  assert.equal(requestBody?.session.audio.output.voice, 'marin');
  assert.match(realtime.openingEvent.response.instructions, /מה תרצה ללמוד/u);
  assert.doesNotMatch(JSON.stringify(realtime), /server-secret/u);
  course.ready = true;
  store.seed(course);
  await assert.rejects(() => service.realtimeSession(scope, course.id), conflict);
});

test('six text and voice answers survive correction and shape the approved plan', async () => {
  const { store, service, ai } = setup();
  const course = courseFixture();
  course.ready = false;
  course.intakeAnswers = [];
  course.messages = [{ role: 'tutor', text: 'What is your goal?', channel: 'text' }];
  store.seed(course);
  ai.handler = async (name, raw) => {
    const data = raw as {
      preferences: typeof preferences;
      answers?: Array<{ topic: string; text: string; channel: string }>;
      correctedTopic?: string;
      learnerAnswers?: Array<{ topic: string; text: string; channel: string }>;
    };
    if (name === 'course_plan') {
      assert.equal(data.learnerAnswers?.[0]?.text, 'Speak with customers');
      assert.equal(data.learnerAnswers?.[1]?.channel, 'text');
      assert.equal(data.learnerAnswers?.[5]?.text, 'Two days a week');
      assert.equal(data.preferences.goal, 'Speak with customers');
      assert.equal(data.preferences.daysPerWeek, 2);
      return plan;
    }
    const proposed = structuredClone(data.preferences);
    if (data.correctedTopic === 'goal') proposed.goal = 'Speak with customers';
    else {
      switch (data.answers?.length) {
        case 0:
          proposed.goal = 'Speak on trips';
          break;
        case 1:
          proposed.experience = 'Some basics';
          break;
        case 3:
          proposed.interests = ['travel', 'food'];
          break;
        case 5:
          proposed.daysPerWeek = 2;
          break;
      }
    }
    return {
      message: data.answers?.length === 6 ? 'Review your details' : 'Next question',
      suggestions: ['Example'],
      ready: true,
      preferences: proposed,
    };
  };
  let saved = await service.course(scope, course.id);
  for (let index = 0; index < 6; index++) {
    const message = [
      'Speak on trips',
      'Some basics',
      'Adult and comfortable reading',
      'Travel and food',
      'Short practical lessons',
      'Two days a week',
    ][index]!;
    const channel = index % 2 ? 'text' : 'voice';
    const response = await service.turn(scope, course.id, {
      ...command(saved.revision),
      mode: 'preferences',
      channel,
      message,
    });
    assert.equal(response.intakeProgress?.answered, index + 1);
    assert.equal(response.ready, index === 5);
    saved = await service.course(scope, course.id);
  }
  assert.deepEqual(
    saved.intakeAnswers?.map((answer) => answer.topic),
    ['goal', 'level', 'ageAndLiteracy', 'interests', 'learningPreferences', 'schedule'],
  );
  assert.equal(saved.intakeAnswers?.[0]?.channel, 'voice');
  assert.equal(saved.intakeAnswers?.[1]?.channel, 'text');
  assert.deepEqual(saved.preferences.interests, ['travel', 'food']);
  assert.equal(saved.preferences.daysPerWeek, 2);
  const corrected = await service.turn(scope, course.id, {
    ...command(saved.revision),
    mode: 'preferences',
    channel: 'text',
    message: 'Speak with customers',
    answerIndex: 0,
  });
  assert.equal(corrected.intakeAnswers?.[0]?.text, 'Speak with customers');
  assert.equal(
    corrected.messages.filter((turn) => turn.role === 'learner')[0]?.text,
    'Speak with customers',
  );
  assert.equal(corrected.preferences.goal, 'Speak with customers');
  assert.deepEqual(corrected.preferences.interests, ['travel', 'food']);
  assert.equal(corrected.preferences.daysPerWeek, 2);
  assert.equal(corrected.intakeProgress?.answered, 6);
  const resumed = await service.turn(scope, course.id, {
    ...command(corrected.revision),
    mode: 'preferences',
    channel: 'text',
    message: 'I also like practicing at work',
  });
  assert.equal(resumed.ready, true);
  assert.equal(resumed.intakeProgress?.answered, 6);
  assert.equal(resumed.intakeAnswers?.[0]?.text, 'Speak with customers');
  assert.deepEqual(resumed.preferences.interests, ['travel', 'food']);
  assert.deepEqual(resumed.suggestions, []);
  const approved = await service.approvePreferences(scope, course.id, command(resumed.revision));
  const draft = await service.plan(scope, course.id, command(approved.revision));
  assert.equal(draft.versions[0]?.preferences.goal, 'Speak with customers');
});

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
test('intake is six short localized questions and respects a stated 1-2 day schedule', async () => {
  const { store, service, ai } = setup();
  const started = await service.start(scope, {
    targetLanguageCode: 'en',
    supportLanguageCode: 'he',
    eventId: randomUUID(),
  });
  assert.deepEqual(started.intakeProgress, { current: 1, answered: 0, total: 6 });
  assert.match(started.messages[0]!.text, /[\u0590-\u05ff]/u);
  assert.equal(JSON.stringify(started).includes('intakeQuestions'), false);
  const answers = [
    'אני רוצה לדבר בעבודה',
    'למדתי קצת בעבר',
    'אני בן 31',
    'קורא וכותב בנוחות',
    'מעניין אותי לדבר על עבודה',
    '10 דקות, 1-2 פעמים בשבוע',
  ];
  let current = started;
  for (const [index, answer] of answers.entries()) {
    current = await service.turn(scope, started.id, {
      ...command(current.revision),
      mode: 'preferences',
      channel: index === 1 ? 'voice' : 'text',
      message: answer,
    });
    assert.equal(current.intakeProgress?.answered, index + 1);
    assert.equal(current.ready, index === 5);
    assert.equal(current.messages.at(-2)?.text, answer);
    if (index === 0) {
      assert.match(current.messages.at(-1)!.text, /נשמע שהמטרה/u);
      assert.notEqual(current.messages.at(-1)!.text, 'מה כבר למדת בשפה הזאת?');
    }
  }
  assert.equal(current.preferences.daysPerWeek, 2);
  assert.equal(current.reportedAvailability, answers[5]);
  assert.equal(current.messages.length, 13);
  assert.equal(
    new Set(current.messages.filter((item) => item.role === 'tutor').map((item) => item.text)).size,
    7,
  );
  assert.equal(ai.calls.filter((name) => name === 'course_intake_questions').length, 1);
  assert.equal(ai.calls.filter((name) => name === 'course_intake').length, 6);
  assert.equal((await service.course(scope, started.id)).preferences.daysPerWeek, 2);
  const corrected = await service.turn(scope, started.id, {
    ...command(current.revision),
    mode: 'preferences',
    channel: 'text',
    message: 'אני מעדיף ללמוד דקדוק',
  });
  assert.equal(corrected.intakeProgress?.answered, 6);
  assert.equal(corrected.ready, true);
  assert.equal(corrected.reportedAvailability, answers[5]);
  assert.equal(
    corrected.preferences.daysPerWeek,
    2,
    'an unrelated correction cannot reset availability',
  );
  const approved = await service.approvePreferences(scope, started.id, command(corrected.revision));
  ai.handler = async (name, data) => {
    assert.equal(name, 'course_plan');
    const input = data as {
      preferences: { daysPerWeek: number };
      learnerAnswers: Array<{ topic: string; text: string; channel: string }>;
      learnerCorrections: string[];
    };
    assert.equal(input.preferences.daysPerWeek, 2);
    assert.deepEqual(input.learnerAnswers[2], {
      topic: 'ageAndLiteracy',
      text: answers[2],
      channel: 'text',
    });
    assert.deepEqual(input.learnerAnswers[5], {
      topic: 'schedule',
      text: answers[5],
      channel: 'text',
    });
    assert.deepEqual(input.learnerCorrections, ['אני מעדיף ללמוד דקדוק']);
    return plan;
  };
  await service.plan(scope, started.id, command(approved.revision));
  assert.equal(store.documents.size, 1);
});
test('intake rejects English questions for a Hebrew conversation before saving', async () => {
  const { store, service, ai } = setup();
  ai.handler = async (name) =>
    name === 'course_intake_questions'
      ? {
          closing: 'Review your details.',
          questions: [
            'What is your goal?',
            'What have you learned?',
            'How old are you?',
            'Can you read?',
            'What interests you?',
            'How often can you study?',
          ].map((question) => ({ question, suggestions: [] })),
        }
      : { valid: true, feedback: 'Clear interview' };
  await assert.rejects(
    service.start(scope, {
      targetLanguageCode: 'en',
      supportLanguageCode: 'he',
      eventId: randomUUID(),
    }),
    (error: unknown) => error instanceof AppError && error.code === 'COURSE_AI_UNAVAILABLE',
  );
  assert.equal(store.documents.size, 0);
  assert.deepEqual(ai.calls, ['course_intake_questions', 'course_intake_questions']);
});
test('intake regenerates questions when the independent review finds repeated topics', async () => {
  const { service, ai } = setup();
  let generation = 0;
  let review = 0;
  ai.handler = async (name, data) => {
    if (name === 'course_intake_questions') {
      generation++;
      if (generation === 2)
        assert.match(String((data as { revisionFeedback: string }).revisionFeedback), /repeated/u);
      return {
        closing: 'אפשר לעבור על הפרטים.',
        questions: [
          'מה המטרה שלך?',
          'מה כבר למדת?',
          'מה הגיל שלך?',
          'איך נוח לך לקרוא?',
          'מה מעניין אותך?',
          'כמה פעמים בשבוע מתאים לך?',
        ].map((question) => ({ question, suggestions: [] })),
      };
    }
    review++;
    return review === 1
      ? { valid: false, feedback: 'Questions 1 and 2 cover repeated topics.' }
      : { valid: true, feedback: 'Clear interview' };
  };
  const started = await service.start(scope, {
    targetLanguageCode: 'en',
    supportLanguageCode: 'he',
    eventId: randomUUID(),
  });
  assert.equal(started.intakeProgress?.total, 6);
  assert.equal(generation, 2);
  assert.equal(review, 2);
});
test('an existing unfinished intake is capped at six learner answers', async () => {
  const { store, service, ai } = setup();
  const course = courseFixture();
  course.ready = false;
  for (let index = 0; index < 5; index++) {
    course.messages.push({ role: 'learner', text: `answer ${index}`, channel: 'text' });
    course.messages.push({ role: 'tutor', text: `question ${index}`, channel: 'text' });
  }
  store.seed(course);
  assert.deepEqual(publicCourse(course).intakeProgress, { current: 6, answered: 5, total: 6 });
  ai.handler = async () => ({
    message: 'אפשר לעבור על הפרטים.',
    suggestions: ['עוד שאלה'],
    ready: false,
    preferences,
  });
  const result = await service.turn(scope, course.id, {
    ...command(0),
    mode: 'preferences',
    channel: 'text',
    message: 'תשובה שישית',
  });
  assert.equal(result.ready, true);
  assert.deepEqual(result.suggestions, []);
  assert.equal(result.intakeProgress, null);
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
test('a choice only accepts its keyed displayed option even when legacy answer variants include another choice', async () => {
  const { store, service } = setup();
  const homework = homeworkFixture();
  const choice = homework.content!.tasks[0]!;
  choice.kind = 'choice';
  choice.prompt = 'Is she busy? No, ____.';
  choice.choices = ["she isn't", 'she is', 'I am'];
  choice.expectedAnswer = "she isn't";
  choice.acceptedAnswers = ["she isn't", 'she is'];
  store.seed(homework);
  const result = await service.homeworkAction(scope, homework.id, {
    ...command(0),
    taskIndex: 0,
    action: 'answer',
    answer: 'she is',
    channel: 'text',
  });
  assert.equal(result.tasks[0]?.attempts[0]?.result, 'retry');
  await assert.rejects(
    service.homeworkAction(scope, homework.id, {
      ...command(result.revision),
      taskIndex: 0,
      action: 'answer',
      answer: 'they are',
      channel: 'text',
    }),
    (error: unknown) => error instanceof AppError && error.statusCode === 400,
  );
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
    const content = expandedHomeworkContent();
    content.tasks[0]!.sourceQuote = 'This was never taught';
    return content;
  };
  await assert.rejects(service.prepareHomework(scope, homework.id, command(0)));
  assert.equal((await service.homework(scope, homework.id)).content, null);
});
test('daily homework rejects the old two-minute size and duration', () => {
  const short = homeworkFixture().content!;
  assert.equal(homeworkContentSchema.safeParse(short).success, false);
  assert.equal(homeworkContentSchema.safeParse(expandedHomeworkContent()).success, true);
  assert.equal(
    homeworkContentSchema.safeParse({ ...expandedHomeworkContent(), estimatedMinutes: 3 }).success,
    false,
  );
});
test('homework generation repairs repeated questions instead of padding the practice', async () => {
  const { store, service, ai } = setup();
  const homework = homeworkFixture();
  homework.content = null;
  homework.progress = [];
  store.seed(homework);
  let generations = 0;
  ai.handler = async (name, data) => {
    if (name === 'lesson_homework_review') return { valid: true, feedback: 'Clear and grounded' };
    generations++;
    const content = expandedHomeworkContent();
    if (generations === 1) content.tasks[2]!.prompt = content.tasks[0]!.prompt;
    else
      assert.match(String((data as { revisionFeedback: string }).revisionFeedback), /different/u);
    return content;
  };
  const prepared = await service.prepareHomework(scope, homework.id, command(0));
  assert.equal(generations, 2);
  assert.equal(prepared.tasks.length, 12);
  assert.equal(prepared.estimatedMinutes, 12);
  assert.deepEqual(ai.calls, ['lesson_homework', 'lesson_homework', 'lesson_homework_review']);
});
test('generation repairs an ambiguous short-answer task before saving', async () => {
  const { store, service, ai } = setup();
  const homework = homeworkFixture();
  homework.content = null;
  homework.progress = [];
  store.seed(homework);
  let generations = 0;
  ai.handler = async (name, data) => {
    if (name === 'lesson_homework_review') return { valid: true, feedback: 'Clear and grounded' };
    const content = expandedHomeworkContent();
    if (name === 'lesson_homework') {
      generations++;
      if (generations === 1) {
        content.tasks[1]!.prompt = 'Choose the correct short answer: No, ____.';
        content.tasks[1]!.choices = ["it isn't", 'she is', 'I am'];
        content.tasks[1]!.expectedAnswer = "it isn't";
        content.tasks[1]!.acceptedAnswers = ["it isn't"];
      } else {
        assert.match(
          String((data as { revisionFeedback: string }).revisionFeedback),
          /actual question/u,
        );
      }
    }
    return content;
  };
  const prepared = await service.prepareHomework(scope, homework.id, command(0));
  assert.equal(generations, 2);
  assert.equal(prepared.tasks[1]?.prompt, 'Which sentence says our group is at home?');
  assert.equal(prepared.tasks.length, 12);
  assert.equal(prepared.estimatedMinutes, 12);
  assert.equal((await service.homework(scope, homework.id)).qualityVersion, 2);
});
test('independent review rejects a choice with no unique grammar answer', async () => {
  const { store, service, ai } = setup();
  const homework = homeworkFixture();
  homework.content = null;
  homework.progress = [];
  store.seed(homework);
  ai.handler = async (name) =>
    name === 'lesson_homework_review'
      ? { valid: false, feedback: 'Task 2 has two grammatically correct choices in this context.' }
      : expandedHomeworkContent();
  await assert.rejects(service.prepareHomework(scope, homework.id, command(0)));
  assert.equal((await service.homework(scope, homework.id)).content, null);
  assert.deepEqual(ai.calls, [
    'lesson_homework',
    'lesson_homework_review',
    'lesson_homework',
    'lesson_homework_review',
  ]);
});
test('unstarted legacy homework is refreshed while attempted homework remains stable', async () => {
  const { store, service, ai } = setup();
  const legacy = homeworkFixture();
  legacy.content!.tasks[1]!.prompt = 'Choose the correct short answer: No, ____.';
  store.seed(legacy);
  assert.equal(publicHomework(legacy).needsRefresh, true);
  const refreshed = await service.prepareHomework(scope, legacy.id, command(0));
  assert.equal(refreshed.needsRefresh, false);
  assert.equal(refreshed.tasks[1]?.prompt, 'Which sentence says our group is at home?');
  assert.deepEqual(ai.calls, ['lesson_homework', 'lesson_homework_review']);

  const attempted = homeworkFixture();
  attempted.progress[0]!.attempts.push({
    answer: 'We is at home.',
    channel: 'text',
    result: 'retry',
    feedback: 'Try again.',
    independent: false,
    createdAt: attempted.createdAt,
  });
  store.seed(attempted);
  const resumed = await service.prepareHomework(scope, attempted.id, command(0));
  assert.equal(resumed.revision, 0);
  assert.equal(resumed.needsRefresh, false);
  assert.equal(ai.calls.length, 2);
});
test('homework generation restricts source quotes to saved lesson excerpts', async () => {
  const store = new MemoryLearningStore();
  const homework = homeworkFixture();
  homework.content = null;
  homework.progress = [];
  homework.source.turns.push({ role: 'learner', text: 'We are at home.' });
  store.seed(homework);
  const provider = new OpenAiCourseGenerator(
    'test-key',
    'configured-model',
    'configured-transcriber',
    async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      if (body.text.format.name === 'lesson_homework')
        assert.deepEqual(
          body.text.format.schema.properties.tasks.items.properties.sourceQuote.enum,
          ['I am at home.', 'We are at home.'],
        );
      return Response.json({
        status: 'completed',
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify(
                  body.text.format.name === 'lesson_homework_review'
                    ? { valid: true, feedback: 'Clear and grounded' }
                    : expandedHomeworkContent(),
                ),
              },
            ],
          },
        ],
      });
    },
  );
  const service = new CourseService(store, profiles, provider);
  const prepared = await service.prepareHomework(scope, homework.id, command(0));
  assert.equal(prepared.revision, 1);
  assert.equal(prepared.tasks.length, 12);
  assert.equal(
    (await service.homework(scope, homework.id)).content?.tasks[0]?.sourceQuote,
    'I am at home.',
  );
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
  await request(app).delete(`/api/v1/courses/${course.id}`).expect(401);
  await request(app)
    .delete(`/api/v1/courses/${course.id}`)
    .set('Authorization', 'Bearer fixture')
    .expect(204);
  assert.equal(await store.get(scope, course.id), null);
  assert.equal(API_ROUTES.filter(({ path }) => path.startsWith('/api/v1/courses')).length, 14);
  assert.equal(
    new Set(API_ROUTES.map(({ method, path }) => `${method} ${path}`)).size,
    API_ROUTES.length,
  );
  assert.equal(API_ROUTES.length, 78);
});

test('course session resolves approved language and objective before creating the Realtime session', async () => {
  const { store, service } = setup();
  const course = courseFixture();
  const approved = { ...preferences, absoluteBeginner: false, supportLanguageCode: 'he' };
  Object.assign(course, {
    activeVersion: 1,
    approvedPreferences: approved,
    preferencesApprovedAt: course.createdAt,
    versions: [{ version: 1, preferences: approved, plan, createdAt: course.createdAt }],
  });
  store.seed(course);
  let sessionInstructions = '';
  const lessons = new PrivateLessonService({
    courses: service,
    apiKey: 'fixture-key',
    model: 'fixture-realtime',
    voice: 'marin',
    transcriptionModel: 'fixture-transcriber',
    profiles,
    vocabulary: {
      learned: async () => {
        throw new Error('Unrelated vocabulary must not replace course material');
      },
    },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      sessionInstructions = body.session.instructions;
      assert.match(body.session.instructions, /course/);
      assert.equal(body.session.audio.input.transcription.language, undefined);
      return Response.json({ value: 'ek_fixture' });
    },
  });
  const input = privateLessonInputSchema.parse({
    courseId: course.id,
    targetLanguageCode: 'de',
    supportLanguageCode: 'de',
    lessonMode: 'absolute_beginner',
    requestedDurationMinutes: 1,
  });
  const result = await lessons.createSession(scope, input);
  assert.equal(result.lesson.targetLanguageCode, 'en');
  assert.equal(result.lesson.supportLanguageCode, 'he');
  assert.equal(result.lesson.durationSeconds, 600);
  assert.equal(result.lesson.lessonMode, 'standard');
  assert.equal(result.lesson.course?.objective, plan.units[0]!.lessons[0]!.objective);
  assert.equal(result.lesson.roadmap, null);
  assert.deepEqual(result.lesson.targetWords, []);
  // response.create.instructions overrides the session prompt. Every application
  // initiated turn must keep the complete approved context, not just a directive.
  for (const event of [
    result.realtime.openingEvent,
    result.realtime.continuationEvent,
    result.realtime.translationEvent,
    result.realtime.wrapUpEvent,
  ]) {
    assert.ok(
      event?.response.instructions.startsWith(
        sessionInstructions + '\n\n# Current turn directive\n',
      ),
    );
    assert.ok(event?.response.instructions.includes(plan.units[0]!.lessons[0]!.objective));
  }
  const opening = result.realtime.openingEvent.response.instructions.split(
    '# Current turn directive\n',
  )[1]!;
  assert.match(opening, /Speak only in English/u);
  assert.match(opening, /Explain the concept and when to use it/u);
  assert.match(opening, /show a clear example/u);
  assert.match(opening, /then ask one open understanding question/u);
  assert.doesNotMatch(opening, /in Hebrew/u);
  assert.match(sessionInstructions, /same language policy applies inside and outside a course/u);
  assert.doesNotMatch(sessionInstructions, /Use SUPPORT_LANGUAGE .*when useful/u);
  assert.match(
    sessionInstructions,
    /An empty targetVocabulary list does not cancel a course objective/u,
  );
  assert.match(sessionInstructions, /Avoid repetition loops/u);
  assert.match(sessionInstructions, /Never end with praise alone/u);
  assert.match(sessionInstructions, /when and why to use each form/u);
  assert.match(sessionInstructions, /contrasting examples/u);
});
