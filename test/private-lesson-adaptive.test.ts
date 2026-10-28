import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import { adminRuntimeContext } from '../src/modules/admin/admin.context.js';
import {
  AdaptiveLessonPlanner,
  adaptivePlanIssues,
  authoredMaterialIssue,
  lessonPlanningRequirements,
} from '../src/modules/private-lessons/private-lesson.planner.js';
import {
  advanceActivity,
  initialActivity,
  LessonActivityService,
  type ActivityRecord,
  type LessonActivityCommand,
  type ActivityAssessment,
  type ActivityState,
  type LessonActivityStore,
} from '../src/modules/private-lessons/private-lesson.activity.js';
import { buildRealtimeLessonContract } from '../src/modules/private-lessons/private-lesson.realtime.js';
import { adaptiveLesson, adaptiveCurriculum } from './helpers/adaptive-lesson-fixtures.js';
import {
  basicPrivateLessonReport,
  sanitizeReport,
} from '../src/modules/private-lessons/private-lesson.summary.js';

const scope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
test('impossible exact authored content is rejected before publishing and default adaptive content remains usable', () => {
  const material = {
    words: [],
    readingPassage: '',
    teacherInstructions: 'A short authored instruction.',
    realtimeInstructions: '',
    practice: null,
  };
  assert.equal(authoredMaterialIssue(material, 1200), null);
  assert.match(
    authoredMaterialIssue({ ...material, adaptationPolicy: 'authored_only' }, 1200)!,
    /shorten the lesson or permit adaptation/,
  );
});
test('summary cannot promote an assisted activity into independent level or roadmap evidence', () => {
  const plan = adaptiveLesson();
  plan.roadmap = {
    roadmapId: randomUUID(),
    milestoneId: randomUUID(),
    milestoneKey: 'foundation',
    goalTitle: 'Travel',
    communicationObjective: 'Ask for information',
    grammarTopics: [],
    successCriteria: { minimumLessons: 2, targetScore: 75 },
    evidenceLessonCount: 0,
    isFirstMilestoneLesson: true,
  };
  plan.learningEvidence = [
    {
      activityId: 'task-1',
      family: 'asking',
      outcome: 'assisted',
      attempts: 1,
      learnerAnswer: 'Where is the station?',
    },
  ];
  const report = basicPrivateLessonReport(plan);
  for (const skill of Object.values(report.assessment.skills)) {
    skill.evidenceQuality = 'strong';
    skill.dimensions = {
      accuracy: 90,
      independence: 90,
      range: 90,
      complexity: 90,
      consistency: 90,
    };
    skill.evidence = [
      { learnerQuote: 'Where is the station?', observation: 'A clear question', independent: true },
    ];
  }
  report.roadmapProgress = {
    objectiveCompletionScore: 90,
    targetFormControlScore: 90,
    score: 90,
    taskCompleted: true,
    confidence: 'high',
    evidence: 'A fluent answer',
  };
  const checked = sanitizeReport(report, plan, [
    { role: 'learner', text: 'Where is the station?' },
  ]);
  assert.equal(checked.assessment.lessonPerformance.independence, 0);
  assert.equal(checked.assessment.overallLevel, null);
  assert.equal(checked.roadmapProgress?.taskCompleted, false);
  assert.ok(
    Object.values(checked.assessment.skills).every((skill) =>
      skill.evidence.every((item) => !item.independent),
    ),
  );
});
const command = (
  record: ActivityRecord,
  action: LessonActivityCommand['action'] = 'answer',
): LessonActivityCommand => ({
  eventId: randomUUID(),
  revision: record.state.view.revision,
  activityId: record.state.view.activityId,
  action,
  ...(action === 'answer' ? { answer: 'Where is the station?', channel: 'text' as const } : {}),
});
const assessment = (result: ActivityAssessment['result']): ActivityAssessment => ({
  result,
  feedback: 'בדקנו את המשמעות בהקשר.',
  retryQuestion: 'What would you ask for in a different case?',
  evidenceQuote: result === 'independent' ? 'Where is the station?' : '',
});
function record(duration = 600): ActivityRecord {
  const plan = adaptiveLesson(duration),
    curriculum = adaptiveCurriculum(plan);
  return {
    plan,
    curriculum,
    state: initialActivity(plan, curriculum, 'guided'),
    active: true,
    remainingSeconds: duration,
  };
}
function answer(r: ActivityRecord, result: ActivityAssessment['result']) {
  return { ...r, state: advanceActivity(r, command(r), assessment(result)) };
}

test('activity budget scales across every supported lesson duration, not unit identifiers', () => {
  assert.ok(
    lessonPlanningRequirements({ ...adaptiveLesson(), speechRate: 'slow' }).minimumActivities <
      lessonPlanningRequirements(adaptiveLesson()).minimumActivities,
  );
  for (const duration of [60, 120, 180, 300, 600, 900, 1200]) {
    const plan = adaptiveLesson(duration),
      curriculum = adaptiveCurriculum(plan);
    // Tiny sessions have a smaller core/support budget.
    if (duration <= 120)
      curriculum.activities = curriculum.activities.map((item, i) => ({
        ...item,
        route: i < 2 ? 'core' : i === 2 ? 'support' : 'extension',
      }));
    else if (curriculum.activities.length < 9)
      curriculum.activities = curriculum.activities.map((item, i) => ({
        ...item,
        route: i < 3 ? 'core' : i < 5 ? 'support' : 'extension',
      }));
    assert.deepEqual(adaptivePlanIssues(plan, curriculum), [], `duration ${duration}`);
  }
  assert.ok(
    lessonPlanningRequirements(adaptiveLesson(1200)).minimumActivities >
      lessonPlanningRequirements(adaptiveLesson(300)).minimumActivities,
  );
});

test('fast learner gets new language operations and challenge after independent answers', () => {
  let r = record();
  r = answer(r, 'independent');
  assert.equal(r.state.view.activityId, 'task-1');
  assert.equal(
    r.state.outcomes[0]?.outcome,
    'assisted',
    'meaning/scaffolded task cannot certify independent production',
  );
  r = answer(r, 'independent');
  r = answer(r, 'independent');
  assert.equal(r.state.view.reason, 'challenge');
  assert.equal(
    r.curriculum.activities.find((item) => item.id === r.state.view.activityId)?.route,
    'extension',
  );
  assert.equal(new Set(r.state.visited).size, r.state.visited.length);
});

test('two unsuccessful attempts move to support; renamed siblings cannot restart a family', () => {
  let r = record();
  r.curriculum.activities[4]!.family = r.curriculum.activities[0]!.family;
  r = answer(r, 'incorrect');
  assert.equal(r.state.view.attempts, 1);
  const original = r.state.view.activityId;
  r = answer(r, 'incorrect');
  assert.notEqual(r.state.view.activityId, original);
  assert.notEqual(r.state.view.activityId, 'task-4');
  assert.equal(r.state.view.reason, 'support');
  assert.equal(r.state.outcomes[0]?.outcome, 'needs_later_practice');
});

test('correct, copied and hinted responses advance without inventing independence', () => {
  let r = record();
  r.state = advanceActivity(r, command(r, 'hint'));
  assert.equal(r.state.view.attempts, 0);
  r = answer(r, 'independent');
  assert.equal(r.state.outcomes[0]?.outcome, 'assisted');
  r = answer(r, 'assisted');
  assert.equal(r.state.outcomes[1]?.outcome, 'assisted');
  assert.equal(r.state.independentStreak, 0);
});

test('help, uncertainty and replay do not manufacture attempts or reset the retry budget', () => {
  let r = answer(record(), 'incorrect');
  const id = r.state.view.activityId;
  r = answer(r, 'help');
  r = answer(r, 'unclear');
  assert.equal(r.state.view.activityId, id);
  assert.equal(r.state.view.attempts, 1);
  r = answer(r, 'incorrect');
  assert.notEqual(r.state.view.activityId, id);
});

test('time and exhaustion produce a transparent finish, never restart a mastered task', () => {
  const r = record();
  r.remainingSeconds = 8;
  const nearEnd = answer(r, 'independent');
  assert.equal(nearEnd.state.view.status, 'closing');
  const empty = record();
  empty.state.visited = empty.curriculum.activities.slice(1).map((item) => item.id);
  assert.equal(answer(empty, 'independent').state.view.status, 'exhausted');
});

test('planner rejects duplicated or out-of-unit work and independent-check leaks before opening', () => {
  const r = record();
  r.curriculum.activities[1]!.prompt = r.curriculum.activities[0]!.prompt;
  assert.ok(adaptivePlanIssues(r.plan, r.curriculum).includes('Duplicate prompt'));
  r.plan.wordPack = {
    words: [
      {
        sourceText: 'station',
        translationText: 'תחנה',
        introduced: true,
        exampleText: null,
        learningItemId: null,
      },
    ],
  } as NonNullable<typeof r.plan.wordPack>;
  r.curriculum.activities[0]!.requiredWords = ['future-word'];
  assert.ok(
    adaptivePlanIssues(r.plan, r.curriculum).includes(
      'Vocabulary outside the server-resolved unit scope',
    ),
  );
});

test('explicitly selected unprepared unit words remain teachable without fabricating preparation', () => {
  const r = record();
  r.plan.wordPack = {
    words: [
      {
        sourceText: 'station',
        translationText: 'תחנה',
        introduced: false,
        exampleText: null,
        learningItemId: null,
      },
    ],
  } as NonNullable<typeof r.plan.wordPack>;
  r.curriculum.activities[0]!.requiredWords = ['station'];
  assert.deepEqual(adaptivePlanIssues(r.plan, r.curriculum), []);
  assert.equal(r.plan.wordPack.words[0]!.introduced, false);
});

test('all authored and generated inputs use one planner and an independent semantic review', async () => {
  let generated = 0,
    reviewed = 0;
  const plan = adaptiveLesson();
  plan.wordPack = {
    words: [],
    material: {
      words: [],
      teacherInstructions: 'A very short authored lesson',
      realtimeInstructions: '',
      readingPassage: '',
      practice: null,
    },
  } as unknown as NonNullable<typeof plan.wordPack>;
  const planner = new AdaptiveLessonPlanner({
    async generate<T>(
      _scope: unknown,
      schema: z.ZodType<T>,
      name: string,
      _instruction: string,
      data: unknown,
    ) {
      assert.equal((data as { durationSeconds?: number }).durationSeconds, 600);
      if (name === 'private_lesson_plan') {
        generated++;
        return schema.parse(adaptiveCurriculum(plan));
      }
      reviewed++;
      return schema.parse({
        valid: true,
        excludeIds: [],
        feedback: 'Distinct, grounded language operations',
      });
    },
  });
  await planner.prepare(scope, plan, 'guided');
  assert.equal(generated, 1);
  assert.equal(reviewed, 1);
});

test('invalid material is bounded to one plan and four focused repairs and never accepted as sufficient', async () => {
  let calls = 0;
  const plan = adaptiveLesson();
  const planner = new AdaptiveLessonPlanner({
    async generate<T>(_scope: unknown, schema: z.ZodType<T>, name: string) {
      calls++;
      const candidate = adaptiveCurriculum(plan);
      candidate.activities = candidate.activities.slice(0, 3);
      return schema.parse(
        name === 'private_lesson_plan_repair'
          ? {
              opening: null,
              exhaustedMessage: null,
              replacements: candidate.activities,
              removeIds: [],
            }
          : candidate,
      );
    },
  });
  await assert.rejects(planner.prepare(scope, plan, 'guided'), {
    code: 'PRIVATE_LESSON_PLAN_INSUFFICIENT',
  });
  assert.equal(calls, 5);
});

test('semantic repair preserves approved task order and is independently reviewed again', async () => {
  const plan = adaptiveLesson();
  const bank = adaptiveCurriculum(plan);
  bank.activities.forEach((activity) => {
    activity.estimatedSeconds = 20;
  });
  assert.deepEqual(adaptivePlanIssues(plan, bank), []);
  let reviews = 0;
  const repaired = await new AdaptiveLessonPlanner({
    async generate<T>(_s: unknown, schema: z.ZodType<T>, name: string) {
      if (name === 'private_lesson_plan') return schema.parse(bank);
      if (name === 'private_lesson_plan_review')
        return schema.parse({
          valid: ++reviews === 3,
          excludeIds: [],
          feedback: 'Repair the first prompt while preserving sound tasks.',
        });
      assert.equal(name, 'private_lesson_plan_repair');
      return schema.parse({
        opening: null,
        exhaustedMessage: null,
        removeIds: [],
        replacements: [{ ...bank.activities[0]!, prompt: 'A genuinely different first task.' }],
      });
    },
  }).prepare(scope, plan, 'guided');
  assert.equal(reviews, 3);
  assert.equal(repaired.activities[0]!.prompt, 'A genuinely different first task.');
  assert.deepEqual(repaired.activities.slice(1), bank.activities.slice(1));
});

test('review exclusions remove bad optional tasks but cannot approve an under-covered remaining bank', async () => {
  const plan = adaptiveLesson();
  const bank = adaptiveCurriculum(adaptiveLesson(1200));
  for (const thin of [false, true]) {
    const planner = new AdaptiveLessonPlanner({
      async generate<T>(
        _s: unknown,
        schema: z.ZodType<T>,
        name: string,
        _instruction: string,
        data: unknown,
      ) {
        if (name === 'private_lesson_plan') return schema.parse(bank);
        if (name === 'private_lesson_plan_review')
          return schema.parse({
            valid: true,
            feedback: 'Remove these unsuitable alternatives; assess the remainder.',
            excludeIds: thin
              ? bank.activities.slice(3).map((activity) => activity.id)
              : [bank.activities[0]!.id],
          });
        const current = (data as { candidate: typeof bank }).candidate;
        return schema.parse({
          opening: null,
          exhaustedMessage: null,
          removeIds: [],
          replacements: [current.activities[0]],
        });
      },
    });
    if (thin)
      await assert.rejects(planner.prepare(scope, plan, 'guided'), {
        code: 'PRIVATE_LESSON_PLAN_INSUFFICIENT',
      });
    else {
      const approved = await planner.prepare(scope, plan, 'guided');
      assert.ok(!approved.activities.some((activity) => activity.id === bank.activities[0]!.id));
      assert.deepEqual(adaptivePlanIssues(plan, approved), []);
    }
  }
});

test('adaptive turn contract retains active prompt but disables autonomous VAD for both configurations', () => {
  for (const type of ['server_vad', 'semantic_vad'] as const) {
    const contract = buildRealtimeLessonContract(
      adaptiveLesson(),
      { model: 'test-realtime', transcriptionModel: 'test-transcription' },
      {
        instructions: 'Custom teacher guidance',
        realtime: { session: { audio: { input: { turn_detection: { type } } } } },
      },
    );
    assert.equal(contract.session.audio.input.turn_detection.create_response, false);
    assert.match(contract.session.instructions, /Server-managed activity protocol/);
    assert.match(contract.events.continuation.response.instructions, /Custom teacher guidance/);
  }
});

test('a provider failure preserves the exact task and retry receipt boundary', async () => {
  const r = record();
  let saves = 0;
  const store: LessonActivityStore = {
    async create() {},
    async get() {
      return structuredClone(r);
    },
    async replay() {
      return null;
    },
    async save(_s, _id, _c, state) {
      saves++;
      return state;
    },
  };
  const service = new LessonActivityService(store, {
    async generate() {
      throw new Error('provider failed');
    },
  });
  await assert.rejects(service.act(scope, r.plan.id, command(r)));
  assert.equal(saves, 0);
  assert.equal(r.state.view.revision, 0);
});

test('active lessons keep their evaluation prompt revision after an admin changes the default', async () => {
  const r = record();
  r.plan.evaluationPrompt = {
    id: 'original-revision',
    instructions: 'Original evaluator guidance',
  };
  const store: LessonActivityStore = {
    async create() {},
    async get() {
      return structuredClone(r);
    },
    async replay() {
      return null;
    },
    async save(_s, _id, _c, state) {
      return state;
    },
  };
  const service = new LessonActivityService(store, {
    async generate<T>(_s: unknown, schema: z.ZodType<T>) {
      assert.equal(adminRuntimeContext.getStore()?.prompts.courses?.id, 'original-revision');
      return schema.parse(assessment('assisted'));
    },
  });
  await adminRuntimeContext.run(
    {
      ...scope,
      requestId: 'test-request',
      prompts: { courses: { id: 'changed-revision', instructions: 'Changed guidance' } },
    },
    () => service.act(scope, r.plan.id, command(r)),
  );
});

test('transcript correction is an annotation and cannot create a new learning attempt', async () => {
  const r = answer(record(), 'incorrect');
  let saved: ActivityState | undefined;
  const store: LessonActivityStore = {
    async create() {},
    async get() {
      return structuredClone(r);
    },
    async replay() {
      return null;
    },
    async save(_s, _id, _c, state) {
      saved = state;
      return state;
    },
  };
  const service = new LessonActivityService(store, {
    async generate<T>(_s: unknown, schema: z.ZodType<T>) {
      return schema.parse(assessment('independent'));
    },
  });
  await service.act(scope, r.plan.id, {
    ...command(r, 'review'),
    correctedAnswer: 'Where is the station?',
  });
  assert.equal(saved?.view.attempts, 1);
  assert.deepEqual(saved?.outcomes, r.state.outcomes);
  assert.equal(saved?.view.review?.status, 'reviewed');
});
