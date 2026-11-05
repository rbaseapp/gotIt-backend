// Within-learner experiments on curriculum target words.
//
// Each learner is their own control: inside every unit, half of the unit's
// targets go to each arm (stable, deterministic, no stored assignment). The
// outcome is delayed independent recall, read from the learner's WordEvidence:
// a word counts as retained once it reached `retained` or `maintenance`, which
// curriculum.policy.ts grants only after unassisted recall 7+ days later.
// This needs far fewer learners than a between-group A/B test, because the
// large differences between learners cancel out in the paired comparison.
import { createHash } from 'node:crypto';
import type { WordEvidence } from './curriculum.policy.js';

export type Experiment = {
  id: string;
  arms: readonly string[];
  /** Only words introduced on or after this time take part. */
  startsAt: string;
  description: string;
};

export const EXPERIMENTS: readonly Experiment[] = [
  {
    // A/A calibration: both arms receive the same teaching. It checks that
    // assignment and analysis show no difference before a real comparison
    // (e.g. Rachel transfer task vs games only) uses the same pipeline.
    id: 'aa-calibration-2026-11',
    arms: ['a', 'b'],
    startsAt: '2026-11-05T00:00:00.000Z',
    description: 'A/A calibration of within-learner word assignment and delayed-recall analysis',
  },
];

const DAY = 86_400_000;
/** A word's outcome is read once this many days have passed since it was introduced. */
export const OUTCOME_AFTER_DAYS = 28;

const rank = (experimentId: string, userId: string, targetId: string) =>
  createHash('sha256').update(`${experimentId}:${userId}:${targetId}`).digest('hex');

/**
 * Arm of every target in one unit for one learner: targets are ordered by a
 * keyed hash and dealt round-robin, so each arm gets an equal share (±1).
 */
export function unitAssignment(
  experiment: Experiment,
  userId: string,
  unitTargetIds: readonly string[],
): Map<string, string> {
  const ordered = [...unitTargetIds].sort((x, y) =>
    rank(experiment.id, userId, x).localeCompare(rank(experiment.id, userId, y)),
  );
  return new Map(ordered.map((id, i) => [id, experiment.arms[i % experiment.arms.length]!]));
}

export type WordOutcome = 'retained' | 'not_retained' | 'pending' | 'excluded';

export function wordOutcome(experiment: Experiment, word: WordEvidence, now: Date): WordOutcome {
  // Words known from placement or marked as already known were not taught here.
  if (word.source) return 'excluded';
  const introduced = Date.parse(word.introducedAt);
  if (introduced < Date.parse(experiment.startsAt)) return 'excluded';
  if (+now - introduced < OUTCOME_AFTER_DAYS * DAY) return 'pending';
  return word.status === 'retained' || word.status === 'maintenance' ? 'retained' : 'not_retained';
}

export type ArmTotals = { words: number; retained: number; rate: number | null };
export type ExperimentReport = {
  experiment: string;
  learners: number;
  /** Learners with a decided word in every arm; only they enter the paired estimate. */
  pairedLearners: number;
  pendingWords: number;
  arms: Record<string, ArmTotals>;
  /** Mean within-learner difference of retention rate, arms[1] minus arms[0]. */
  meanDifference: number | null;
  /** Approximate 95% interval of meanDifference (normal approximation). */
  interval95: [number, number] | null;
};

export function analyzeExperiment(
  experiment: Experiment,
  learners: readonly { userId: string; words: Record<string, WordEvidence> }[],
  unitTargets: ReadonlyMap<string, readonly string[]>,
  now: Date,
): ExperimentReport {
  const [first, second] = experiment.arms;
  const arms = Object.fromEntries(
    experiment.arms.map((arm) => [arm, { words: 0, retained: 0, rate: null as number | null }]),
  );
  const differences: number[] = [];
  let pendingWords = 0;
  for (const learner of learners) {
    const own: Record<string, { words: number; retained: number }> = {};
    for (const [, targetIds] of unitTargets) {
      const assignment = unitAssignment(experiment, learner.userId, targetIds);
      for (const id of targetIds) {
        const word = learner.words[id];
        if (!word) continue;
        const outcome = wordOutcome(experiment, word, now);
        if (outcome === 'pending') pendingWords++;
        if (outcome !== 'retained' && outcome !== 'not_retained') continue;
        const arm = assignment.get(id)!;
        own[arm] ??= { words: 0, retained: 0 };
        own[arm].words++;
        arms[arm]!.words++;
        if (outcome === 'retained') {
          own[arm].retained++;
          arms[arm]!.retained++;
        }
      }
    }
    const a = own[first!],
      b = own[second!];
    if (a?.words && b?.words) differences.push(b.retained / b.words - a.retained / a.words);
  }
  for (const totals of Object.values(arms))
    totals.rate = totals.words ? totals.retained / totals.words : null;
  const n = differences.length;
  const mean = n ? differences.reduce((s, d) => s + d, 0) / n : null;
  let interval: [number, number] | null = null;
  if (mean !== null && n >= 2) {
    const variance = differences.reduce((s, d) => s + (d - mean) ** 2, 0) / (n - 1);
    const half = 1.96 * Math.sqrt(variance / n);
    interval = [mean - half, mean + half];
  }
  return {
    experiment: experiment.id,
    learners: learners.length,
    pairedLearners: n,
    pendingWords,
    arms,
    meanDifference: mean,
    interval95: interval,
  };
}
