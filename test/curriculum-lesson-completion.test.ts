import assert from 'node:assert/strict';
import test from 'node:test';
import { CurriculumService } from '../src/modules/curriculum/curriculum.service.js';
import { PROGRAM_VERSION, content } from '../src/modules/curriculum/curriculum.content.js';
import { curriculumPathSteps } from '../src/modules/curriculum/curriculum.path.js';
import type { CurriculumStore, Enrollment } from '../src/modules/curriculum/curriculum.store.js';
import { basicPrivateLessonReport } from '../src/modules/private-lessons/private-lesson.summary.js';
import { adaptiveLesson } from './helpers/adaptive-lesson-fixtures.js';
import { profiles, scope } from './helpers/course-fixtures.js';

function fixture() {
  const enrollment: Enrollment = {
    revision: 0,
    state: {
      minutes: 20,
      timezone: 'Asia/Jerusalem',
      literacy: 'starting',
      currentUnit: 'P01',
      words: {},
      completed: {},
      cursors: {},
      drafts: {},
      activeSeconds: 0,
      lastReadingSeconds: 0,
      lastReadingTargets: 0,
      placement: {},
      recentSessions: [],
    },
  };
  const receipts = new Set<string>();
  const store = {
    async command(
      _scope: unknown,
      id: string,
      _input: unknown,
      _revision: unknown,
      apply: (value: Enrollment) => Promise<unknown>,
    ) {
      if (receipts.has(id)) return;
      await apply(enrollment);
      receipts.add(id);
    },
  } as unknown as CurriculumStore;
  let evaluations = 0;
  const service = new CurriculumService(store, profiles, {
    async transcribe() {
      throw new Error('Unexpected audio request');
    },
    async generate(_scope, schema) {
      evaluations++;
      return schema.parse({ completedThrough: 0, learnerQuote: 'Hi', nextStep: 'Continue' });
    },
  });
  const authored = content.lessons.find((lesson) => lesson.id === 'P01-L1')!;
  const plan = {
    ...adaptiveLesson(),
    curriculum: {
      lessonId: authored.id,
      version: PROGRAM_VERSION,
      cursor: 0,
      title: authored.title_he,
      script: authored.teacher_script,
      branches: authored.branches,
    },
    learningEvidence: [
      {
        activityId: 'greeting',
        family: 'greeting',
        outcome: 'assisted',
        attempts: 1,
        learnerAnswer: 'Hi',
      },
    ],
  };
  const report = basicPrivateLessonReport(plan);
  assert.equal(report.assessment.lessonPerformance.evidenceQuality, 'insufficient');
  return { service, enrollment, plan, report, evaluations: () => evaluations };
}

test('finished adaptive beginner lesson advances to follow-up with short assisted answers, without CEFR credit', async () => {
  const f = fixture();
  const turns = [{ role: 'learner', text: 'Hi' }];
  await f.service.recordLesson(scope, f.plan, f.report, turns, { adaptiveFinished: true });
  assert.equal(f.enrollment.state.cursors['teacher:P01-L1'], f.plan.curriculum.script.length);
  assert.equal(f.enrollment.state.completed['teacher:P01-L1']?.independent, false);
  assert.equal(f.evaluations(), 0);
  assert.equal(f.report.assessment.overallLevel, null);
  const steps = curriculumPathSteps(f.enrollment.state, 'P01');
  assert.equal(steps.find((step) => step.id === 'teacher:P01-L1')?.complete, true);
  assert.equal(steps.find((step) => step.id === 'post:P01-L1')?.available, true);
  const before = structuredClone(f.enrollment.state);
  await f.service.recordLesson(scope, f.plan, f.report, turns, { adaptiveFinished: true });
  assert.deepEqual(f.enrollment.state, before);
});

test('early exit saves partial authored progress and keeps the lesson unfinished', async () => {
  const f = fixture();
  await f.service.recordLesson(scope, f.plan, f.report, [{ role: 'learner', text: 'Hi' }], {
    adaptiveFinished: false,
  });
  assert.equal(f.enrollment.state.cursors['teacher:P01-L1'], 1);
  assert.equal(f.enrollment.state.completed['teacher:P01-L1'], undefined);
  assert.equal(f.evaluations(), 1);
});

test('empty, skipped and mismatched server answers cannot complete a beginner lesson', async () => {
  for (const kind of ['empty', 'skipped', 'mismatch', 'legacy'] as const) {
    const f = fixture();
    if (kind === 'empty') f.plan.learningEvidence = [];
    if (kind === 'skipped') f.plan.learningEvidence[0]!.outcome = 'skipped';
    if (kind === 'mismatch') f.plan.learningEvidence[0]!.learnerAnswer = 'Invented';
    if (kind === 'legacy') delete f.plan.interactionProtocol;
    await f.service.recordLesson(scope, f.plan, f.report, [{ role: 'learner', text: 'Hi' }], {
      adaptiveFinished: true,
    });
    assert.equal(f.enrollment.state.completed['teacher:P01-L1'], undefined, kind);
    assert.equal(f.evaluations(), 0, kind);
  }
});
