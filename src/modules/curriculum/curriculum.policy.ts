import type { Band } from './curriculum.content.js';

export const REVIEW_DAYS = [1, 3, 7, 14, 30, 60, 90] as const;
export type Dimension = 'meaning' | 'recall' | 'listening' | 'context' | 'decoding';
export type WordEvidence = {
  introducedAt: string;
  lastExposureAt: string;
  lastIndependentAt: string | null;
  independentDays: string[];
  firstIndependentAt: string | null;
  stage: number;
  retrievalDays: string[];
  practiceModes: Record<string, number>;
  dueAt: string;
  failures: number[];
  dimensions: Partial<Record<Dimension, number>>;
  status: 'introduced' | 'acquiring' | 'usable' | 'retained' | 'maintenance';
  /** Present when the word came from the onboarding placement rather than from a lesson. */
  source?: 'placement';
};
const DAY = 86_400_000;
export function introduce(now: Date): WordEvidence {
  const at = now.toISOString();
  return {
    introducedAt: at,
    lastExposureAt: at,
    lastIndependentAt: null,
    independentDays: [],
    firstIndependentAt: null,
    retrievalDays: [],
    practiceModes: {},
    stage: 0,
    dueAt: new Date(+now + DAY).toISOString(),
    failures: [],
    dimensions: {},
    status: 'introduced',
  };
}
export function recallEvidence(
  previous: WordEvidence,
  input: {
    correct: boolean;
    assisted: boolean;
    dimension: Dimension;
    timezone: string;
    now: Date;
    retrievalCued?: boolean;
  },
): WordEvidence {
  const next = structuredClone(previous),
    now = input.now;
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: input.timezone }).format(now);
  next.failures = [...next.failures, input.correct ? 0 : 1].slice(-3);
  if (!input.correct) {
    // Repair one skill; previous successful evidence is retained.
    next.dueAt = new Date(+now + 10 * 60_000).toISOString();
    return next;
  }
  if (input.assisted) {
    next.lastExposureAt = now.toISOString();
    return next;
  }
  next.retrievalDays ??= [];
  const sameDay = next.retrievalDays.includes(day);
  const activeRetrieval = ['recall', 'context'].includes(input.dimension) && !input.retrievalCued;
  const sinceLast = next.lastIndependentAt ? +now - Date.parse(next.lastIndependentAt) : Infinity;
  const sinceExposure = +now - Date.parse(next.lastExposureAt);
  // Immediate reconstruction after viewing a model is not independent recall.
  if (sinceExposure < 10 * 60_000) return next;
  next.dimensions[input.dimension] = (next.dimensions[input.dimension] ?? 0) + 1;
  next.status = 'acquiring';
  if (!next.independentDays.includes(day)) next.independentDays.push(day);
  if (activeRetrieval) next.firstIndependentAt ??= now.toISOString();
  if (activeRetrieval && !sameDay) {
    next.retrievalDays.push(day);
    next.lastIndependentAt = now.toISOString();
    // A calendar-day boundary alone is insufficient: require the due interval too.
    if (+now >= Date.parse(previous.dueAt)) next.stage = Math.min(6, next.stage + 1);
    next.dueAt = new Date(+now + REVIEW_DAYS[next.stage]! * DAY).toISOString();
  }
  const usable =
    next.retrievalDays.length >= 2 &&
    (next.dimensions.recall ?? 0) >= 2 &&
    (next.dimensions.context ?? 0) >= 1 &&
    (next.dimensions.listening ?? 0) >= 1;
  if (usable) next.status = 'usable';
  if (activeRetrieval && usable && sinceLast >= 7 * DAY) next.status = 'retained';
  if (
    activeRetrieval &&
    usable &&
    next.firstIndependentAt &&
    +now - Date.parse(next.firstIndependentAt) >= 30 * DAY &&
    sinceLast >= 14 * DAY
  )
    next.status = 'maintenance';
  // Established status does not regress merely because another dimension was practised.
  const order = ['introduced', 'acquiring', 'usable', 'retained', 'maintenance'];
  if (order.indexOf(previous.status) > order.indexOf(next.status)) next.status = previous.status;
  return next;
}
export function reviewPriority(word: WordEvidence, now: Date, importance = 2, weakSkill = true) {
  const interval = REVIEW_DAYS[word.stage]! * DAY;
  const overdue = Math.min(3, Math.max(0, (+now - Date.parse(word.dueAt)) / interval));
  return (
    3 * word.failures.reduce((sum, failure) => sum + failure, 0) +
    2 * overdue +
    importance +
    Number(weakSkill)
  );
}
export const READING_DOSE: Record<
  Band,
  { targets: number; minutes: number; min: number; max: number; selected: number }
> = {
  'Pre-A1': { targets: 6, minutes: 30, min: 20, max: 40, selected: 4 },
  A1: { targets: 12, minutes: 60, min: 70, max: 110, selected: 6 },
  A2: { targets: 18, minutes: 90, min: 140, max: 220, selected: 8 },
  B1: { targets: 24, minutes: 120, min: 250, max: 400, selected: 10 },
  B2: { targets: 30, minutes: 150, min: 450, max: 700, selected: 12 },
  C1: { targets: 30, minutes: 180, min: 700, max: 1200, selected: 12 },
};
export function dailyPlan(minutes: number) {
  const plans: Record<number, Array<{ kind: string; minutes: number }>> = {
    10: [
      { kind: 'review', minutes: 4 },
      { kind: 'rotate', minutes: 5 },
      { kind: 'wrap', minutes: 1 },
    ],
    20: [
      { kind: 'review', minutes: 6 },
      { kind: 'rotate', minutes: 12 },
      { kind: 'wrap', minutes: 2 },
    ],
    30: [
      { kind: 'review', minutes: 8 },
      { kind: 'rotate', minutes: 20 },
      { kind: 'wrap', minutes: 2 },
    ],
    45: [
      { kind: 'review', minutes: 10 },
      { kind: 'teacher', minutes: 15 },
      { kind: 'postlesson', minutes: 10 },
      { kind: 'input', minutes: 8 },
      { kind: 'wrap', minutes: 2 },
    ],
    60: [
      { kind: 'review', minutes: 12 },
      { kind: 'teacher', minutes: 20 },
      { kind: 'postlesson', minutes: 10 },
      { kind: 'input', minutes: 15 },
      { kind: 'wrap', minutes: 3 },
    ],
  };
  return plans[minutes] ?? plans[20]!;
}
