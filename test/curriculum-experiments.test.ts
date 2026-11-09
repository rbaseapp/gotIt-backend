import test from 'node:test';
import assert from 'node:assert/strict';
import { content } from '../src/modules/curriculum/curriculum.content.js';
import {
  analyzeExperiment,
  EXPERIMENTS,
  experimentById,
  experimentUnitTargets,
  lessonScriptFor,
  unitAssignment,
  wordOutcome,
  type Experiment,
} from '../src/modules/curriculum/curriculum.experiments.js';
import type { WordEvidence } from '../src/modules/curriculum/curriculum.policy.js';

const experiment: Experiment = {
  id: 'test-exp',
  arms: ['a', 'b'],
  startsAt: '2026-01-01T00:00:00.000Z',
  description: 'test',
};
const now = new Date('2026-06-01T00:00:00.000Z');
const ids = (unit: string, n = 12) => Array.from({ length: n }, (_, i) => `${unit}-T${i + 1}`);
const units = new Map([
  ['U1', ids('U1')],
  ['U2', ids('U2')],
  ['U3', ids('U3')],
]);

// Deterministic pseudo-random numbers (mulberry32) for reproducible simulations.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const word = (status: WordEvidence['status'], introducedAt = '2026-02-01T00:00:00.000Z') =>
  ({ introducedAt, status }) as WordEvidence;

function simulate(learners: number, effect: number, seed: number) {
  const rnd = random(seed);
  return Array.from({ length: learners }, (_, i) => {
    const userId = `user-${i}`;
    const base = 0.2 + 0.7 * rnd(); // learners differ a lot; pairing removes it
    const words: Record<string, WordEvidence> = {};
    for (const [, targetIds] of units) {
      const arms = unitAssignment(experiment, userId, targetIds);
      for (const id of targetIds) {
        const p = Math.min(1, base + (arms.get(id) === 'b' ? effect : 0));
        words[id] = word(rnd() < p ? 'retained' : 'usable');
      }
    }
    return { userId, words };
  });
}

test('assignment is stable and splits every unit evenly for each learner', () => {
  const one = unitAssignment(experiment, 'user-1', ids('U1'));
  assert.deepEqual(unitAssignment(experiment, 'user-1', ids('U1')), one);
  const counts = [...one.values()].reduce<Record<string, number>>(
    (c, arm) => ({ ...c, [arm]: (c[arm] ?? 0) + 1 }),
    {},
  );
  assert.deepEqual(counts, { a: 6, b: 6 });
  const odd = [...unitAssignment(experiment, 'user-1', ids('U9', 7)).values()];
  assert.ok(Math.abs(odd.filter((a) => a === 'a').length - 3.5) <= 0.5);
  // Different learners get different splits of the same unit.
  assert.notDeepEqual([...unitAssignment(experiment, 'user-2', ids('U1'))], [...one]);
});

test('word outcome waits for the delay and ignores placement or pre-experiment words', () => {
  assert.equal(wordOutcome(experiment, word('retained'), now), 'retained');
  assert.equal(wordOutcome(experiment, word('usable'), now), 'not_retained');
  assert.equal(wordOutcome(experiment, word('maintenance'), now), 'retained');
  assert.equal(wordOutcome(experiment, word('usable', '2026-05-20T00:00:00.000Z'), now), 'pending');
  assert.equal(
    wordOutcome(experiment, word('retained', '2025-12-01T00:00:00.000Z'), now),
    'excluded',
  );
  assert.equal(
    wordOutcome(experiment, { ...word('retained'), source: 'placement' }, now),
    'excluded',
  );
});

test('an A/A run shows no difference', () => {
  const report = analyzeExperiment(experiment, simulate(200, 0, 7), units, now);
  assert.equal(report.pairedLearners, 200);
  const [low, high] = report.interval95!;
  assert.ok(low < 0 && high > 0, `interval ${low}..${high} should contain 0`);
  assert.ok(Math.abs(report.meanDifference!) < 0.05);
});

test('a real 15-point effect is detected with 60 learners', () => {
  const report = analyzeExperiment(experiment, simulate(60, 0.15, 11), units, now);
  assert.ok(report.interval95![0] > 0, `interval ${report.interval95} should exclude 0`);
  assert.ok(report.arms.b!.rate! > report.arms.a!.rate!);
});

test('pending words are counted but kept out of the estimate', () => {
  const learners = [
    { userId: 'u', words: { 'U1-T1': word('usable', '2026-05-25T00:00:00.000Z') } },
  ];
  const report = analyzeExperiment(experiment, learners, units, now);
  assert.equal(report.pendingWords, 1);
  assert.equal(report.pairedLearners, 0);
  assert.equal(report.meanDifference, null);
});

test('registered experiments have unique ids and at least two arms', () => {
  assert.equal(new Set(EXPERIMENTS.map((e) => e.id)).size, EXPERIMENTS.length);
  assert.ok(EXPERIMENTS.every((e) => e.arms.length >= 2 && !Number.isNaN(Date.parse(e.startsAt))));
});

test('A/A false-positive rate is close to the nominal 5%', () => {
  let positives = 0;
  const runs = 150;
  for (let seed = 1; seed <= runs; seed++) {
    const [low, high] = analyzeExperiment(
      experiment,
      simulate(40, 0, seed * 97),
      units,
      now,
    ).interval95!;
    if (low > 0 || high < 0) positives++;
  }
  const rate = positives / runs;
  assert.ok(rate >= 0.02 && rate <= 0.09, `false-positive rate ${rate}`);
});

test('the production experiment asks for an own sentence for half of each unit lesson words', () => {
  const production = experimentById.get('teacher-production-2026-11')!;
  const during = new Date('2026-11-10T00:00:00.000Z');
  const lessons = content.lessons.filter((lesson) => lesson.unit === 'A101');
  const changed = lessons.flatMap((lesson) =>
    lessonScriptFor(lesson.teacher_script, lesson, 'user-1', during).filter(
      (phase) => 'production_task_en' in phase,
    ),
  );
  // 12 lesson words in the unit, dealt evenly: six get the extra speaking turn.
  assert.equal(experimentUnitTargets(production).get('A101')!.length, 12);
  assert.equal(changed.length, 6);
  assert.ok(changed.every((phase) => phase.phase === 'teach_target'));
  assert.match(String(changed[0]!.say_en), /in a short sentence of your own/);
  for (const lesson of lessons) {
    const script = lessonScriptFor(lesson.teacher_script, lesson, 'user-1', during);
    assert.equal(script.length, lesson.teacher_script.length);
    // Before the start and after the end every learner gets the authored lesson.
    for (const at of ['2026-11-05T12:00:00.000Z', '2026-12-18T00:00:00.000Z'])
      assert.equal(
        lessonScriptFor(lesson.teacher_script, lesson, 'user-1', new Date(at)),
        lesson.teacher_script,
      );
  }
  // Words introduced after the end do not count.
  assert.equal(
    wordOutcome(production, word('retained', '2026-12-20T00:00:00.000Z'), new Date('2027-02-01')),
    'excluded',
  );
});
