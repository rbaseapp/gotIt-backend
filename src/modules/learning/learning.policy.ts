import { z } from 'zod';
import { fingerprint } from '../enrichment/selection-proof.js';
export const SKILLS = ['recognition', 'recall', 'listening', 'spelling', 'pronunciation'] as const;
export type Skill = (typeof SKILLS)[number];
export const policySchema = z
  .object({
    masteryThreshold: z.number().min(50).max(100).default(85),
    minimumAttemptsPerSkill: z.number().int().min(2).max(100).default(3),
    minimumCalendarDays: z.number().int().min(2).max(30).default(2),
    minimumReviewStage: z.number().int().min(2).max(6).default(4),
    demotionThreshold: z.number().min(0).max(85).default(60),
    intervalsDays: z
      .array(z.number().int().min(1).max(365))
      .min(4)
      .max(10)
      .default([1, 3, 7, 14, 30, 60]),
    masteryWeights: z
      .object({
        recognition: z.number().positive().default(1),
        recall: z.number().positive().default(1.5),
        listening: z.number().positive().default(1),
        spelling: z.number().positive().default(1),
        pronunciation: z.number().positive().default(1),
      })
      .strict()
      .prefault({}),
    dailyXpCap: z.number().int().min(0).max(1000).default(200),
    correctXp: z.number().int().min(0).max(50).default(10),
    partialXp: z.number().int().min(0).max(20).default(3),
    selfRatedXp: z.number().int().min(0).max(20).default(5),
    sessionXp: z.number().int().min(0).max(50).default(10),
    masteryXp: z.number().int().min(0).max(50).default(20),
    dailyGoalXp: z.number().int().min(0).max(50).default(10),
  })
  .strict();
export type LearningPolicy = z.output<typeof policySchema>;
export const DEFAULT_LEARNING_POLICY = policySchema.parse({});
export const policyVersion = (policy: LearningPolicy) =>
  `gotit-v1-${fingerprint(policy).slice(0, 12)}`;
export function calendarDay(timestamp: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(timestamp);
  return ['year', 'month', 'day'].map((k) => parts.find((p) => p.type === k)!.value).join('-');
}
export function previousDay(day: string) {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}
export function levelForXp(xp: number) {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1;
}
export type Evidence = {
  skillType: Skill;
  masteryScore: number;
  confidence: number;
  attemptCount: number;
  successCount: number;
  failureCount: number;
  calendarDays: number;
};
export function projectEvidence(
  scores: number[],
  days: number,
  counts?: { attemptCount: number; successCount: number; failureCount: number },
): Omit<Evidence, 'skillType'> {
  const recent = scores.slice(-10),
    attemptCount = counts?.attemptCount ?? scores.length,
    successCount = counts?.successCount ?? scores.filter((s) => s >= 85).length,
    failureCount = counts?.failureCount ?? scores.filter((s) => s < 50).length;
  const weights = recent.map((_s, i) => i + 1),
    total = weights.reduce((a, b) => a + b, 0);
  return {
    masteryScore: total
      ? Math.round((recent.reduce((sum, score, i) => sum + score * weights[i]!, 0) / total) * 100) /
        100
      : 0,
    confidence: Math.min(1, attemptCount / 10) * Math.min(1, days / 3),
    attemptCount,
    successCount,
    failureCount,
    calendarDays: days,
  };
}
export function decideProgress(
  policy: LearningPolicy,
  evidence: Evidence[],
  enabled: Skill[],
  current: { status: string; stage: number; masterySource: string | null },
  score: number,
  now: Date,
  recentResults: number[],
  canAdvance = true,
) {
  const relevant = evidence.filter((e) => enabled.includes(e.skillType));
  const totalWeight = relevant.reduce((s, e) => s + policy.masteryWeights[e.skillType], 0);
  const mastery = totalWeight
    ? relevant.reduce((s, e) => s + e.masteryScore * policy.masteryWeights[e.skillType], 0) /
      totalWeight
    : 0;
  const failedPattern = recentResults.slice(-3).filter((s) => s < 50).length >= 2;
  let stage = current.stage,
    status = current.status,
    masterySource = current.masterySource;
  const advancesStage = score >= 85 && canAdvance;
  if (advancesStage) stage = Math.min(policy.intervalsDays.length - 1, stage + 1);
  else if (score < 50) stage = Math.max(0, stage - 1);
  const sufficient =
    enabled.length > 0 &&
    enabled.every((skill) =>
      relevant.some(
        (e) =>
          e.skillType === skill &&
          e.attemptCount >= policy.minimumAttemptsPerSkill &&
          e.calendarDays >= policy.minimumCalendarDays &&
          e.masteryScore >= policy.masteryThreshold,
      ),
    );
  if (current.status === 'mastered') {
    if (
      failedPattern ||
      (recentResults.slice(-3).filter((s) => s < 85).length >= 2 &&
        relevant.some(
          (e) =>
            e.attemptCount >= policy.minimumAttemptsPerSkill &&
            e.masteryScore < policy.demotionThreshold,
        ))
    ) {
      status = 'reviewing';
      masterySource = 'system';
    } else status = 'mastered';
  } else if (
    sufficient &&
    mastery >= policy.masteryThreshold &&
    stage >= policy.minimumReviewStage &&
    !failedPattern
  ) {
    status = 'mastered';
    masterySource = 'system';
  } else status = stage >= 1 ? 'reviewing' : 'learning';
  const days =
    status === 'mastered'
      ? policy.intervalsDays.at(-1)!
      : score < 50
        ? 0
        : policy.intervalsDays[stage]!;
  return {
    status,
    stage,
    masterySource,
    masteryScore: Math.round(mastery * 100) / 100,
    nextReviewAt: new Date(now.getTime() + days * 86400000),
  };
}
