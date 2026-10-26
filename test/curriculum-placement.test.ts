import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { content, lexicon } from '../src/modules/curriculum/curriculum.content.js';
import {
  GAP_QUEUE_LIMIT,
  GAP_WORDS_PER_DAY,
  applyPlacement,
  hasLearningProgress,
  studyMinutes,
  tutorGate,
  type PlacementInput,
} from '../src/modules/curriculum/curriculum.placement.js';
import { CurriculumService } from '../src/modules/curriculum/curriculum.service.js';
import type {
  CurriculumState,
  CurriculumStore,
  Enrollment,
} from '../src/modules/curriculum/curriculum.store.js';
import { profiles, scope } from './helpers/course-fixtures.js';

const NOW = new Date('2026-10-25T10:00:00.000Z');
const DAY = 86_400_000;

const emptyState = (): CurriculumState => ({
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
});

const input = (overrides: Partial<PlacementInput> = {}): PlacementInput => ({
  theta: 27,
  startUnit: 25,
  literacy: 'independent',
  minutesPerDay: 15,
  goal: 'work',
  deadlineMonths: 3,
  reliability: 0.9,
  skills: {
    vocabulary: { band: 'A2', score: 0.9 },
    reading: { band: 'A2', score: 0.5 },
    listening: null,
  },
  knownWords: [],
  ...overrides,
});

const targetsIn = (unitIds: string[]) => lexicon.targets.filter((t) => unitIds.includes(t.unit));

test('placement skips the units below the start unit with reversible path choices', () => {
  const state = emptyState();
  const summary = applyPlacement(state, input(), NOW);
  const expected = content.units.slice(0, 24).map((u) => u.id);
  assert.deepEqual(state.pathChoices?.units, expected);
  assert.equal(state.currentUnit, content.units[24]!.id);
  assert.equal(summary.startUnit, 25);
  assert.equal(summary.skippedUnits, 24);
  assert.equal(state.literacy, 'independent');
  assert.equal(state.minutes, 20, '15 minutes a day maps to the 20 minute program setting');
});

test('placement never records the self-reported vocabulary check as independent evidence', () => {
  const state = emptyState();
  applyPlacement(state, input(), NOW);
  assert.equal(state.placement.vocabulary!.independent, false);
  assert.equal(state.placement.reading!.independent, true, 'a probe answer is independent');
  assert.equal(state.placement.listening, undefined);
  assert.deepEqual(state.placement.decoding, { band: 'Pre-A1', score: 1, independent: true });
  const beginner = emptyState();
  applyPlacement(beginner, input({ literacy: 'starting', startUnit: 1, theta: 2 }), NOW);
  assert.equal(beginner.placement.decoding, undefined);
  assert.deepEqual(beginner.pathChoices?.units, []);
  assert.equal(beginner.currentUnit, 'P01');
});

test('known words in skipped units get a light review; unknown ones form a gap queue, three a day', () => {
  const skippedIds = content.units.slice(0, 24).map((u) => u.id);
  const skippedTargets = targetsIn(skippedIds);
  const knownWords = skippedTargets.slice(0, 40).map((t) => t.en);
  const state = emptyState();
  const summary = applyPlacement(state, input({ knownWords }), NOW);
  const knownSet = new Set(knownWords.map((w) => w.toLowerCase()));
  const light = skippedTargets.filter((t) => knownSet.has(t.en.toLowerCase()));
  for (const target of light) {
    const evidence = state.words[target.id]!;
    assert.equal(evidence.status, 'acquiring');
    assert.equal(evidence.source, 'placement');
    assert.equal(+new Date(evidence.dueAt) - +NOW, 21 * DAY);
  }
  assert.equal(summary.knownInSkippedUnits, light.length);
  assert.equal(summary.gapQueued, GAP_QUEUE_LIMIT);
  const gap = Object.values(state.words).filter((w) => w.status === 'introduced');
  assert.equal(gap.length, GAP_QUEUE_LIMIT);
  const days = gap.map((w) => Math.round((+new Date(w.dueAt) - +NOW) / DAY));
  assert.equal(Math.min(...days), 1);
  for (let day = 1; day <= 5; day++)
    assert.equal(days.filter((d) => d === day).length, GAP_WORDS_PER_DAY);
  // Nothing outside the skipped units is touched.
  const touched = new Set(Object.keys(state.words));
  assert.ok(
    lexicon.targets.filter((t) => touched.has(t.id)).every((t) => skippedIds.includes(t.unit)),
  );
});

test('gap words closest to the start unit are queued first', () => {
  const state = emptyState();
  applyPlacement(state, input(), NOW);
  const byDay = Object.entries(state.words)
    .map(([id, w]) => ({ id, day: Math.round((+new Date(w.dueAt) - +NOW) / DAY) }))
    .filter((x) => x.day <= 2);
  const unitIndex = new Map(content.units.map((u, i) => [u.id, i]));
  const firstUnit = (id: string) => unitIndex.get(lexicon.targets.find((t) => t.id === id)!.unit)!;
  assert.ok(
    byDay.every((x) => firstUnit(x.id) >= 22),
    'the first reviews come from units 23-24',
  );
});

test('placement does not overwrite evidence a word already has', () => {
  const state = emptyState();
  const [target] = targetsIn(content.units.slice(0, 24).map((u) => u.id));
  state.words[target!.id] = {
    introducedAt: NOW.toISOString(),
    lastExposureAt: NOW.toISOString(),
    lastIndependentAt: null,
    independentDays: [],
    firstIndependentAt: null,
    retrievalDays: [],
    practiceModes: { recall: 2 },
    stage: 3,
    dueAt: NOW.toISOString(),
    failures: [],
    dimensions: {},
    status: 'usable',
  };
  applyPlacement(state, input({ knownWords: [target!.en] }), NOW);
  assert.equal(state.words[target!.id]!.status, 'usable');
});

test('study minutes map to the program settings', () => {
  assert.deepEqual(
    [5, 10, 11, 20, 25, 30, 40, 60, 90].map(studyMinutes),
    [10, 10, 20, 20, 30, 30, 45, 60, 60],
  );
});

test('real lesson progress is detected, placement bookkeeping is not', () => {
  const state = emptyState();
  applyPlacement(state, input(), NOW);
  assert.equal(hasLearningProgress(state), false);
  state.completed['gate:P01'] = { at: NOW.toISOString(), independent: true, score: 1 };
  assert.equal(hasLearningProgress(state), true);
  const timed = emptyState();
  timed.activeSeconds = 5;
  assert.equal(hasLearningProgress(timed), true);
});

test('the teacher opens at A1, or after three finished units, and never locks legacy learners', () => {
  assert.deepEqual(tutorGate(undefined), {
    unlocked: true,
    reason: 'legacy',
    done: 0,
    required: 0,
  });
  assert.deepEqual(tutorGate(emptyState()), {
    unlocked: true,
    reason: 'legacy',
    done: 0,
    required: 0,
  });
  const placedHigh = emptyState();
  applyPlacement(placedHigh, input({ theta: 7, startUnit: 5 }), NOW);
  assert.equal(tutorGate(placedHigh).unlocked, true);
  const beginner = emptyState();
  applyPlacement(beginner, input({ theta: 3, startUnit: 1, literacy: 'starting' }), NOW);
  assert.deepEqual(tutorGate(beginner), {
    unlocked: false,
    reason: 'progress',
    done: 0,
    required: 3,
  });
  for (const id of ['P01', 'P02'])
    beginner.completed[`gate:${id}`] = { at: NOW.toISOString(), independent: true, score: 1 };
  assert.deepEqual(tutorGate(beginner), {
    unlocked: false,
    reason: 'progress',
    done: 2,
    required: 3,
  });
  beginner.completed['gate:P03'] = { at: NOW.toISOString(), independent: true, score: 1 };
  assert.equal(tutorGate(beginner).unlocked, true);
});

function service() {
  let enrollment: Enrollment | null = null;
  const receipts = new Map<string, unknown>();
  const store = {
    pool: { query: async () => ({ rows: [] }) },
    async catalog() {
      return true;
    },
    async get() {
      return enrollment;
    },
    async command(
      _scope: unknown,
      eventId: string,
      _input: unknown,
      _revision: unknown,
      apply: (value: Enrollment | null) => Promise<{ state: CurriculumState; response: unknown }>,
    ) {
      if (receipts.has(eventId)) return receipts.get(eventId);
      const { state, response } = await apply(enrollment);
      enrollment = { revision: (enrollment?.revision ?? 0) + 1, state };
      receipts.set(eventId, response);
      return response;
    },
  } as unknown as CurriculumStore;
  return {
    service: new CurriculumService(store, profiles, undefined, undefined, () => NOW),
    current: () => enrollment,
  };
}

test('the placement command applies once and replays the same answer for the same event', async () => {
  const { service: s, current } = service();
  const eventId = randomUUID();
  const first = (await s.place(scope, { ...input(), eventId })) as {
    applied: boolean;
    startUnit?: number;
  };
  assert.equal(first.applied, true);
  assert.equal(first.startUnit, 25);
  const revision = current()!.revision;
  const replay = await s.place(scope, { ...input(), eventId });
  assert.deepEqual(replay, first);
  assert.equal(current()!.revision, revision, 'a replay does not write again');
  assert.equal(current()!.state.onboarding!.startUnit, 25);
});

test('a late placement never overwrites a learner who already has progress', async () => {
  const { service: s, current } = service();
  await s.place(scope, { ...input(), eventId: randomUUID() });
  current()!.state.completed['gate:P01'] = { at: NOW.toISOString(), independent: true, score: 1 };
  const before = structuredClone(current()!.state);
  const result = await s.place(scope, {
    ...input({ startUnit: 60, theta: 62 }),
    eventId: randomUUID(),
  });
  assert.deepEqual(result, { applied: false, reason: 'existing_progress' });
  assert.deepEqual(current()!.state.pathChoices, before.pathChoices);
  assert.equal(current()!.state.onboarding!.startUnit, 25);
});

test('learning state exposes the onboarding record and the teacher gate', async () => {
  const { service: s } = service();
  await s.place(scope, {
    ...input({ theta: 3, startUnit: 1, literacy: 'starting' }),
    eventId: randomUUID(),
  });
  const state = await s.get(scope);
  assert.equal((state.onboarding as { startUnit: number }).startUnit, 1);
  assert.equal(state.tutor.unlocked, false);
  assert.equal(state.tutor.required, 3);
  assert.equal((await s.tutorGate(scope)).unlocked, false);
});

test('the answers to the first-entry questions are stored with the placement', async () => {
  const { service: s } = service();
  await s.place(scope, {
    ...input({ profile: { answerMode: 'text', ageBand: '18+', readingComfort: 'some', selfLevel: 2 } }),
    eventId: randomUUID(),
  });
  const state = await s.get(scope);
  assert.deepEqual((state.onboarding as { profile: unknown }).profile, {
    answerMode: 'text',
    ageBand: '18+',
    readingComfort: 'some',
    selfLevel: 2,
  });
});
