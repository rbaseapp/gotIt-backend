import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import { PrivateLessonService } from '../src/modules/private-lessons/private-lesson.service.js';
import {
  LessonActivityService,
  type LessonActivityStore,
  type ActivityRecord,
} from '../src/modules/private-lessons/private-lesson.activity.js';
import type { CourseGenerator } from '../src/modules/courses/course.provider.js';
import type {
  PrivateLessonJournal,
  StoredPrivateLesson,
} from '../src/modules/private-lessons/private-lesson.repository.js';
import {
  basicPrivateLessonReport,
  type PrivateLessonTurn,
} from '../src/modules/private-lessons/private-lesson.summary.js';
import { CourseService } from '../src/modules/courses/course.service.js';
import {
  profiles,
  scope,
  preferences,
  plan as coursePlan,
  courseFixture,
  MemoryLearningStore,
} from './helpers/course-fixtures.js';
import { adaptiveLesson, adaptiveCurriculum } from './helpers/adaptive-lesson-fixtures.js';
import { unitFixture } from './helpers/unit-path-fixtures.js';

test('existing packs, authored courses and standalone future lessons all enter the common adaptive pipeline', async () => {
  for (const entry of [
    'pack',
    'course',
    'standalone',
    'curriculum',
    'curriculum-finished',
  ] as const) {
    const curriculumEntry = entry.startsWith('curriculum');
    const records = new Map<string, ActivityRecord>(),
      lessons = new Map<string, StoredPrivateLesson>();
    let reportedTurns: PrivateLessonTurn[] = [],
      providerSession: Record<string, unknown> | undefined;
    let recordedCurriculum: { outcomes: unknown; finished: boolean | undefined } | undefined;
    const generator: Pick<CourseGenerator, 'generate'> = {
      async generate<T>(
        _scope: unknown,
        schema: z.ZodType<T>,
        name: string,
        _instruction: string,
        data: unknown,
      ) {
        const input = data as {
          durationSeconds: number;
          authoredMaterial?: { teacherInstructions: string };
        };
        if (name === 'private_lesson_plan') {
          if (entry === 'course')
            assert.equal(
              input.authoredMaterial?.teacherInstructions,
              'One short authored explanation.',
            );
          return schema.parse(adaptiveCurriculum(adaptiveLesson(input.durationSeconds)));
        }
        if (name === 'private_lesson_plan_review')
          return schema.parse({
            valid: true,
            excludeIds: [],
            feedback: 'Reviewed independent scope and diversity',
          });
        return schema.parse({
          result: 'assisted',
          feedback: 'A supported answer.',
          retryQuestion: 'Ask in another situation.',
          evidenceQuote: '',
        });
      },
    };
    const store: LessonActivityStore = {
      async markAssisted(_s, id) {
        records.get(id)!.state.view.hintUsed = true;
      },
      async create(_s, lesson, curriculum, state) {
        records.set(lesson.id, {
          plan: lesson,
          curriculum,
          state,
          active: true,
          remainingSeconds: lesson.durationSeconds,
        });
      },
      async get(_s, id) {
        return structuredClone(records.get(id) ?? null);
      },
      async replay() {
        return null;
      },
      async save(_s, id, _c, state) {
        records.get(id)!.state = state;
        return state;
      },
    };
    const journal: PrivateLessonJournal = {
      async create(_s, lesson) {
        lessons.set(lesson.id, {
          ...lesson,
          status: 'active',
          startedAt: new Date().toISOString(),
          endedAt: null,
          actualDurationSeconds: null,
          report: null,
        });
      },
      async get(_s, id) {
        return lessons.get(id) ?? null;
      },
      async list() {
        return [];
      },
      async claim(_s, id) {
        return lessons.get(id) ?? null;
      },
      async complete(_s, id, report) {
        const saved = { ...lessons.get(id)!, status: 'completed' as const, report };
        lessons.set(id, saved);
        return saved;
      },
      async fail() {},
      async remove(_s, id) {
        records.delete(id);
        return lessons.delete(id);
      },
    };
    const documents = new MemoryLearningStore(),
      course = courseFixture();
    course.activeVersion = 1;
    const content = structuredClone(coursePlan);
    content.units[0]!.lessons[0]!.material = {
      words: [],
      readingPassage: '',
      teacherInstructions: 'One short authored explanation.',
      realtimeInstructions: '',
      practice: null,
    };
    course.versions = [{ version: 1, preferences, plan: content, createdAt: course.createdAt }];
    documents.documents.set(documents.key(scope, course.id), course);
    const courses = new CourseService(documents, profiles, undefined);
    const service = new PrivateLessonService({
      apiKey: 'test-secret',
      model: 'test-realtime',
      voice: 'marin',
      transcriptionModel: 'test-transcription',
      profiles,
      vocabulary: {
        async learned() {
          return { items: [] };
        },
      },
      journal,
      activities: new LessonActivityService(store, generator),
      lessonContentGenerator: generator,
      courses: entry === 'course' ? courses : undefined,
      curriculum: curriculumEntry
        ? ({
            async prepareLesson() {
              return {
                band: 'Pre-A1',
                title: 'Authored greetings',
                minutes: 10,
                grammar: 'Greeting and introducing yourself',
                context: {
                  lessonId: 'P01-L1',
                  version: 'test-version',
                  cursor: 0,
                  title: 'Authored greetings',
                  script: [
                    {
                      phase: 'greeting',
                      task_he: 'A greeting in a new context',
                      private_answer_anchor: 'Never read this private anchor',
                    },
                  ],
                  branches: {},
                },
              };
            },
            async recordLesson(
              _scope: unknown,
              plan: StoredPrivateLesson,
              _report: unknown,
              _turns: unknown,
              completion?: { adaptiveFinished: boolean },
            ) {
              recordedCurriculum = {
                outcomes: plan.learningEvidence,
                finished: completion?.adaptiveFinished,
              };
            },
          } as unknown as import('../src/modules/curriculum/curriculum.service.js').CurriculumService)
        : undefined,
      wordPacks: {
        async context(_scope, _id, station) {
          return { context: { ...unitFixture(), station }, targets: [] };
        },
      },
      mapWordPacks: {
        async lessonUnit() {
          return unitFixture();
        },
      },
      summaryGenerator: {
        async generate(lesson, turns) {
          reportedTurns = turns;
          return basicPrivateLessonReport(lesson);
        },
      },
      fetchImpl: async (_url, init) => {
        providerSession = JSON.parse(String(init?.body)).session;
        return Response.json({ value: 'fixture-client-secret' });
      },
    });
    const created = await service.createSession(scope, {
      targetLanguageCode: 'en',
      interactionProtocol: 'adaptive-v1',
      interactionMode: 'guided',
      requestedDurationMinutes: 10,
      ...(entry === 'pack'
        ? { packId: unitFixture().packId, station: 'supported' as const }
        : curriculumEntry
          ? { curriculumLessonId: 'P01-L1' }
          : entry === 'course'
            ? { courseId: course.id }
            : {}),
    });
    assert.ok(created.activity && 'protocolVersion' in created.activity);
    assert.equal(created.activity.protocolVersion, 'adaptive-v1', entry);
    assert.equal(
      (providerSession?.audio as { input: { turn_detection: { create_response: boolean } } }).input
        .turn_detection.create_response,
      false,
    );
    assert.match(created.realtime.openingEvent.response.instructions, /Server-selected tutor turn/);
    assert.doesNotMatch(
      created.realtime.openingEvent.response.instructions,
      /private_answer_anchor/,
    );
    assert.doesNotMatch(
      created.realtime.openingEvent.response.instructions,
      /A meaningful original question about situation/,
    );
    const view = created.activity!;
    const next = await service.act(scope, created.lesson.id, {
      eventId: randomUUID(),
      activityId: view.activityId,
      revision: view.revision,
      action: 'answer',
      answer: 'A supported answer.',
      channel: 'text',
    });
    assert.ok('activityId' in next.activity);
    assert.notEqual(next.activity.activityId, view.activityId);
    assert.equal(next.activity.completedActivities, 1);
    const replay = await service.replayTurn(scope, created.lesson.id, {
      kind: 'translation',
      rate: 'slow',
    });
    assert.equal(replay.revision, next.activity.revision);
    if (entry === 'curriculum-finished') records.get(created.lesson.id)!.remainingSeconds = 0;
    const completed = await service.completeSession(scope, created.lesson.id, {
      actualDurationSeconds: 30,
      completionReason: 'stopped',
      turns: [{ role: 'learner', text: 'Injected client achievement that did not happen.' }],
    });
    assert.ok(reportedTurns.some((turn) => turn.text === 'A supported answer.'));
    assert.ok(!reportedTurns.some((turn) => turn.text.includes('Injected client')));
    assert.equal(completed.report?.activitySummary?.assisted, 1);
    assert.equal(completed.report?.activitySummary?.independent, 0);
    if (curriculumEntry) {
      assert.equal(recordedCurriculum?.finished, entry === 'curriculum-finished');
      assert.deepEqual(
        recordedCurriculum?.outcomes,
        records.get(created.lesson.id)!.state.outcomes,
      );
    }
  }
});

test('adaptive setup failure releases the reservation and never opens a thin lesson', async () => {
  let released = false,
    providerCalled = false;
  const generator: Pick<CourseGenerator, 'generate'> = {
    async generate<T>(_s: unknown, schema: z.ZodType<T>, name: string) {
      const draft = adaptiveCurriculum();
      draft.activities = draft.activities.slice(0, 3);
      return schema.parse(
        name === 'private_lesson_plan_repair'
          ? { opening: null, exhaustedMessage: null, replacements: draft.activities, removeIds: [] }
          : draft,
      );
    },
  };
  const store: LessonActivityStore = {
    async create() {},
    async get() {
      return null;
    },
    async replay() {
      return null;
    },
    async save(_s, _id, _c, state) {
      return state;
    },
  };
  const journal = {
    async create() {},
    async list() {
      return [];
    },
  } as unknown as PrivateLessonJournal;
  const service = new PrivateLessonService({
    apiKey: 'test-secret',
    model: 'test-realtime',
    voice: 'marin',
    transcriptionModel: 'test-transcription',
    profiles,
    vocabulary: {
      async learned() {
        return { items: [] };
      },
    },
    journal,
    lessonContentGenerator: generator,
    activities: new LessonActivityService(store, generator),
    minuteWallet: {
      async reserve() {},
      async release() {
        released = true;
      },
    } as never,
    fetchImpl: async () => {
      providerCalled = true;
      return Response.json({ value: 'fixture' });
    },
  });
  await assert.rejects(
    service.createSession(
      scope,
      { targetLanguageCode: 'en', interactionProtocol: 'adaptive-v1' },
      'fixture-access',
    ),
    { code: 'PRIVATE_LESSON_PLAN_INSUFFICIENT' },
  );
  assert.equal(providerCalled, false);
  assert.equal(released, true);
});
