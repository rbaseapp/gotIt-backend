import assert from 'node:assert/strict';
import test from 'node:test';
import { CurriculumService } from '../src/modules/curriculum/curriculum.service.js';
import { allTargets } from '../src/modules/curriculum/curriculum.content.js';
import { curriculumPathSteps } from '../src/modules/curriculum/curriculum.path.js';
import {
  claimKnown,
  introduce,
  KNOWN_CHECK_DAYS,
  recallEvidence,
} from '../src/modules/curriculum/curriculum.policy.js';
import { wordOutcome } from '../src/modules/curriculum/curriculum.experiments.js';
import type { CurriculumStore, Enrollment } from '../src/modules/curriculum/curriculum.store.js';
import { profiles, scope } from './helpers/course-fixtures.js';

const DAY = 86_400_000;
const now = new Date('2026-11-05T10:00:00.000Z');
const p01 = allTargets.filter((target) => target.unit === 'P01');

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
  const store = {
    async command(
      _scope: unknown,
      _id: string,
      _input: unknown,
      _revision: unknown,
      apply: (value: Enrollment) => Promise<{ response: unknown }>,
    ) {
      return (await apply(enrollment)).response;
    },
    async get() {
      return enrollment;
    },
    async teacherVoice() {
      return 'female';
    },
  } as unknown as CurriculumStore;
  const service = new CurriculumService(store, profiles, undefined, undefined, () => now);
  let event = 0;
  const mark = (targetId: string, known = true) =>
    service.markKnown(scope, { eventId: `e${event++}`, revision: 0, targetId, known });
  return { enrollment, service, mark };
}

test('a known word skips the games and is checked once in review', async () => {
  const { enrollment, service, mark } = fixture();
  assert.deepEqual(await mark(p01[0]!.id), { known: true });
  const word = enrollment.state.words[p01[0]!.id]!;
  assert.equal(word.source, 'self_reported');
  assert.equal(word.status, 'introduced');
  assert.equal(Date.parse(word.dueAt) - +now, KNOWN_CHECK_DAYS * DAY);
  const unit = await service.unit(scope, 'P01');
  for (const game of unit.unit.games) assert.equal(game.eligible, p01.length - 1);
});

test('the word games finish without the words the learner already knows', () => {
  const { enrollment } = fixture();
  const state = enrollment.state;
  const [known, ...rest] = p01;
  state.words[known!.id] = claimKnown(now);
  for (const target of rest)
    state.words[target.id] = {
      ...introduce(now),
      practiceModes: { recognition: 1, recall: 1, listening: 1, context: 1 },
    };
  const games = curriculumPathSteps(state, 'P01').filter((step) => step.id.startsWith('words:'));
  assert.equal(games.length, 4);
  assert.ok(games.every((step) => step.complete));
  // The known word also counts as introduced, so its lesson's introduction is done.
  assert.ok(
    curriculumPathSteps(state, 'P01').find((step) => step.id === 'introduce:P01-L1')!.complete,
  );
});

test('a missed check turns the word back into an ordinary new word', () => {
  const claimed = claimKnown(now);
  const later = new Date(+now + 3 * DAY);
  const missed = recallEvidence(claimed, {
    correct: false,
    assisted: false,
    dimension: 'recall',
    timezone: 'Asia/Jerusalem',
    now: later,
  });
  assert.equal(missed.source, undefined);
  assert.equal(missed.stage, 0);
  const passed = recallEvidence(claimed, {
    correct: true,
    assisted: false,
    dimension: 'recall',
    timezone: 'Asia/Jerusalem',
    now: later,
  });
  assert.equal(passed.source, 'self_reported');
  // Recalled after the check was due: the next review is two weeks away, not tomorrow.
  assert.equal(passed.stage, 3);
});

test('an unchecked claim can be undone, a word in practice cannot be claimed', async () => {
  const { enrollment, mark } = fixture();
  const [first, second] = p01;
  await mark(first!.id);
  assert.deepEqual(await mark(first!.id, false), { known: false });
  assert.equal(enrollment.state.words[first!.id], undefined);
  // Being shown the word is not practice: it can still be marked as known.
  enrollment.state.words[second!.id] = introduce(now);
  assert.deepEqual(await mark(second!.id), { known: true });
  enrollment.state.words[first!.id] = { ...introduce(now), practiceModes: { recall: 1 } };
  await assert.rejects(mark(first!.id), /already part of your practice/);
  await assert.rejects(mark('NOPE-T01'), /not found/);
});

test('known words stay out of the teaching experiments', () => {
  const experiment = { id: 'x', arms: ['a', 'b'], startsAt: now.toISOString(), description: '' };
  assert.equal(wordOutcome(experiment, claimKnown(now), new Date(+now + 40 * DAY)), 'excluded');
});
