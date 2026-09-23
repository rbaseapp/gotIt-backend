import { z } from 'zod';
import { fingerprint } from '../enrichment/selection-proof.js';
export const SKILLS = ['recognition', 'recall', 'listening', 'spelling', 'pronunciation'] as const;
export type Skill = (typeof SKILLS)[number];
export const LEARNED_REVIEW_STAGE = 2;
export const ESTABLISHED_REVIEW_STAGE = 4;
export type RetentionLevel = 'acquiring' | 'learned' | 'established';
export const policySchema = z
  .object({
    masteryThreshold: z.number().min(50).max(100).default(80),
    minimumScoredAttempts: z.number().int().min(1).max(100).default(3),
    minimumActiveRecallSuccesses: z.number().int().min(1).max(100).default(2),
    minimumActiveRecallCalendarDays: z.number().int().min(1).max(30).default(2),
    demotionThreshold: z.number().min(0).max(85).default(60),
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
    intervalsDays: z
      .array(z.number().int().min(1).max(365))
      .min(5)
      .max(10)
      .default([1, 3, 7, 14, 30, 60]),
    dailyXpCap: z.number().int().min(0).max(1000).default(200),
    postDailyCapPercent: z.number().int().min(0).max(100).default(25),
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
  `gotit-v1.1-${fingerprint(policy).slice(0, 12)}`;
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
export function xpAwardForDailyTotal(
  requestedXp: number,
  dailyXp: number,
  dailyXpCap: number,
  postDailyCapPercent: number,
) {
  const fullRateXp = Math.min(requestedXp, Math.max(0, dailyXpCap - dailyXp)),
    reducedRateBase = requestedXp - fullRateXp,
    reducedRateXp =
      reducedRateBase > 0 && postDailyCapPercent > 0
        ? Math.max(1, Math.round((reducedRateBase * postDailyCapPercent) / 100))
        : 0;
  return fullRateXp + reducedRateXp;
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
export type MasteryEvidence = {
  totalScoredAttempts: number;
  activeRecallSuccesses: number;
  activeRecallCalendarDays: number;
  activeRecallMasteryScore: number;
};
export type MasteryRequirements = {
  totalScoredAttempts: number;
  minimumScoredAttempts: number;
  activeRecallSuccesses: number;
  minimumActiveRecallSuccesses: number;
  activeRecallCalendarDays: number;
  minimumActiveRecallCalendarDays: number;
  activeRecallMasteryScore: number;
  masteryThreshold: number;
  reviewStage: number;
  learnedReviewStage: number;
  needsTypedRecall: boolean;
};
export function masteryRequirements(
  policy: LearningPolicy,
  evidence: MasteryEvidence,
  stage: number,
  status: string,
): MasteryRequirements {
  return {
    totalScoredAttempts: evidence.totalScoredAttempts,
    minimumScoredAttempts: policy.minimumScoredAttempts,
    activeRecallSuccesses: evidence.activeRecallSuccesses,
    minimumActiveRecallSuccesses: policy.minimumActiveRecallSuccesses,
    activeRecallCalendarDays: evidence.activeRecallCalendarDays,
    minimumActiveRecallCalendarDays: policy.minimumActiveRecallCalendarDays,
    activeRecallMasteryScore: Math.round(evidence.activeRecallMasteryScore * 100) / 100,
    masteryThreshold: policy.masteryThreshold,
    reviewStage: stage,
    learnedReviewStage: LEARNED_REVIEW_STAGE,
    needsTypedRecall:
      status !== 'mastered' &&
      (evidence.totalScoredAttempts < policy.minimumScoredAttempts ||
        evidence.activeRecallSuccesses < policy.minimumActiveRecallSuccesses ||
        evidence.activeRecallCalendarDays < policy.minimumActiveRecallCalendarDays ||
        evidence.activeRecallMasteryScore < policy.masteryThreshold ||
        stage < LEARNED_REVIEW_STAGE),
  };
}
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
export function projectOverallMastery(policy: LearningPolicy, evidence: Evidence[]) {
  // An untried skill is not a failed skill. Learning completion is guarded
  // separately by active-recall requirements, while this projection describes
  // the quality of evidence the learner has actually produced.
  const attempted = evidence.filter((entry) => entry.attemptCount > 0),
    totalWeight = attempted.reduce((sum, entry) => sum + policy.masteryWeights[entry.skillType], 0);
  return totalWeight
    ? Math.round(
        (attempted.reduce(
          (sum, entry) => sum + entry.masteryScore * policy.masteryWeights[entry.skillType],
          0,
        ) /
          totalWeight) *
          100,
      ) / 100
    : 0;
}
export function decideProgress(
  policy: LearningPolicy,
  evidence: MasteryEvidence,
  current: { status: string; stage: number; masterySource: string | null },
  score: number,
  now: Date,
  recentResults: number[],
  activeRecallAttempt: boolean,
  canAdvance = true,
  overallMasteryScore = evidence.activeRecallMasteryScore,
) {
  const failedPattern = recentResults.slice(-3).filter((s) => s < 50).length >= 2;
  let stage = current.stage,
    status = current.status,
    masterySource = current.masterySource;
  const advancesStage = activeRecallAttempt && score >= 85 && canAdvance;
  if (advancesStage) stage = Math.min(policy.intervalsDays.length - 1, stage + 1);
  else if (activeRecallAttempt && score < 50) stage = Math.max(0, stage - 1);
  const sufficient =
    evidence.totalScoredAttempts >= policy.minimumScoredAttempts &&
    evidence.activeRecallSuccesses >= policy.minimumActiveRecallSuccesses &&
    evidence.activeRecallCalendarDays >= policy.minimumActiveRecallCalendarDays &&
    evidence.activeRecallMasteryScore >= policy.masteryThreshold;
  if (current.status === 'mastered') {
    if (
      failedPattern ||
      (recentResults.slice(-3).filter((s) => s < 85).length >= 2 &&
        evidence.activeRecallSuccesses >= policy.minimumActiveRecallSuccesses &&
        evidence.activeRecallMasteryScore < policy.demotionThreshold)
    ) {
      status = 'reviewing';
      masterySource = 'system';
    } else status = 'mastered';
  } else if (sufficient && score >= 85 && stage >= LEARNED_REVIEW_STAGE && !failedPattern) {
    status = 'mastered';
    masterySource = 'system';
  } else status = stage >= 1 ? 'reviewing' : 'learning';
  const retentionLevel = retentionLevelFor(status, stage);
  const days =
    retentionLevel === 'established'
      ? policy.intervalsDays.at(-1)!
      : score < 50
        ? 0
        : policy.intervalsDays[stage]!;
  return {
    status,
    stage,
    masterySource,
    masteryScore: Math.round(overallMasteryScore * 100) / 100,
    retentionLevel,
    masteryRequirements: masteryRequirements(policy, evidence, stage, status),
    nextReviewAt: new Date(now.getTime() + days * 86400000),
  };
}

export function retentionLevelFor(status: string, stage: number): RetentionLevel {
  if (status !== 'mastered') return 'acquiring';
  return stage >= ESTABLISHED_REVIEW_STAGE ? 'established' : 'learned';
}
