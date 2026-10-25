/**
 * Applies the result of the onboarding "Pocket" check to a learner's curriculum state.
 *
 * Pure functions: the service wraps them in the idempotent enrollment command.
 *
 * - Units below the start unit are skipped with the existing reversible path choices.
 * - Words the learner said they know in those units get a light review (21 days out).
 * - Words in those units the learner did not claim are queued as a "gap queue": three a
 *   day through the existing due-review mechanism, so skipping never leaves holes.
 * - The self-reported check is never recorded as independent evidence.
 */
import { BANDS, content, lexicon, type Band } from './curriculum.content.js';
import { introduce, type WordEvidence } from './curriculum.policy.js';
import type { CurriculumState } from './curriculum.store.js';

const DAY = 86_400_000;
/** Words from skipped units that are queued for review, closest to the start unit first. */
export const GAP_QUEUE_LIMIT = 150;
export const GAP_WORDS_PER_DAY = 3;
const LIGHT_REVIEW_DAYS = 21;
/** The learner has reached A1 (unit 7) or beyond: free conversation can open. */
export const TUTOR_UNLOCK_THETA = 7;
export const TUTOR_UNLOCK_UNITS = 3;

export type PlacementSkill = { band: Band; score: number };
export type PlacementInput = {
  theta: number;
  startUnit: number;
  literacy: CurriculumState['literacy'];
  minutesPerDay: number;
  goal: string;
  deadlineMonths: number;
  reliability: number;
  skills: {
    vocabulary: PlacementSkill;
    reading: PlacementSkill | null;
    listening: PlacementSkill | null;
  };
  knownWords: string[];
};

export const studyMinutes = (minutesPerDay: number): 10 | 20 | 30 | 45 | 60 =>
  minutesPerDay <= 10
    ? 10
    : minutesPerDay <= 20
      ? 20
      : minutesPerDay <= 30
        ? 30
        : minutesPerDay <= 45
          ? 45
          : 60;

export function hasLearningProgress(state: CurriculumState) {
  return (
    Object.keys(state.completed).length > 0 ||
    state.activeSeconds > 0 ||
    Object.values(state.words).some(
      (word) => word.source !== 'placement' && Object.keys(word.practiceModes ?? {}).length > 0,
    )
  );
}

export function applyPlacement(state: CurriculumState, input: PlacementInput, now: Date) {
  const unitIds = content.units.map((unit) => unit.id);
  const startUnit = Math.min(Math.max(input.startUnit, 1), unitIds.length);
  const skipped = unitIds.slice(0, startUnit - 1);
  const skippedSet = new Set(skipped);

  state.pathChoices = {
    units: [...new Set([...(state.pathChoices?.units ?? []), ...skipped])],
    activities: state.pathChoices?.activities ?? [],
  };
  state.currentUnit = unitIds[startUnit - 1]!;
  state.literacy = input.literacy;
  state.minutes = studyMinutes(input.minutesPerDay);
  state.placement = {
    ...state.placement,
    vocabulary: {
      band: input.skills.vocabulary.band,
      score: input.skills.vocabulary.score,
      independent: false,
    },
    ...(input.skills.reading
      ? {
          reading: {
            band: input.skills.reading.band,
            score: input.skills.reading.score,
            independent: true,
          },
        }
      : {}),
    ...(input.skills.listening
      ? {
          listening: {
            band: input.skills.listening.band,
            score: input.skills.listening.score,
            independent: true,
          },
        }
      : {}),
    ...(input.literacy === 'independent'
      ? { decoding: { band: 'Pre-A1', score: 1, independent: true } }
      : {}),
  };
  state.onboarding = {
    theta: input.theta,
    startUnit,
    goal: input.goal,
    deadlineMonths: input.deadlineMonths,
    minutesPerDay: input.minutesPerDay,
    reliability: input.reliability,
    placedAt: now.toISOString(),
  };

  const known = new Set(input.knownWords.map((word) => word.toLowerCase()));
  const unitOrder = new Map(unitIds.map((id, index) => [id, index]));
  const inSkipped = lexicon.targets
    .filter((target) => skippedSet.has(target.unit) && !state.words[target.id])
    .sort((a, b) => unitOrder.get(b.unit)! - unitOrder.get(a.unit)!);
  let knownLight = 0;
  let queued = 0;
  for (const target of inSkipped) {
    const evidence: WordEvidence = introduce(now);
    if (known.has(target.en.toLowerCase())) {
      Object.assign(evidence, {
        stage: 2,
        status: 'acquiring' as const,
        dueAt: new Date(+now + LIGHT_REVIEW_DAYS * DAY).toISOString(),
        source: 'placement' as const,
      });
      knownLight += 1;
    } else {
      if (queued >= GAP_QUEUE_LIMIT) continue;
      evidence.dueAt = new Date(
        +now + (1 + Math.floor(queued / GAP_WORDS_PER_DAY)) * DAY,
      ).toISOString();
      evidence.source = 'placement';
      queued += 1;
    }
    state.words[target.id] = evidence;
  }
  return {
    startUnit,
    unitId: state.currentUnit,
    band:
      BANDS[Math.max(0, BANDS.indexOf(input.skills.vocabulary.band))] ??
      input.skills.vocabulary.band,
    skippedUnits: skipped.length,
    knownInSkippedUnits: knownLight,
    gapQueued: queued,
  };
}

export function tutorGate(state: CurriculumState | undefined) {
  const onboarding = state?.onboarding;
  // Learners who never went through onboarding keep their existing access.
  if (!onboarding) return { unlocked: true, reason: 'legacy' as const, done: 0, required: 0 };
  const done = Object.keys(state!.completed).filter((key) => key.startsWith('gate:')).length;
  if (onboarding.theta >= TUTOR_UNLOCK_THETA)
    return { unlocked: true, reason: 'placed' as const, done, required: 0 };
  return {
    unlocked: done >= TUTOR_UNLOCK_UNITS,
    reason: 'progress' as const,
    done: Math.min(done, TUTOR_UNLOCK_UNITS),
    required: TUTOR_UNLOCK_UNITS,
  };
}
