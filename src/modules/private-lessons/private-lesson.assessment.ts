import type { CefrLevel } from '../profile/profile.types.js';
import { grammarTopics } from './private-lesson.curriculum.js';
import type { PrivateLessonPlan } from './private-lesson.prompt.js';

export const ASSESSMENT_SKILLS = [
  'speaking',
  'vocabulary',
  'grammar',
  'fluency',
  'comprehension',
] as const;
export type AssessmentSkill = (typeof ASSESSMENT_SKILLS)[number];

export const EVIDENCE_QUALITIES = ['insufficient', 'weak', 'moderate', 'strong'] as const;
export type EvidenceQuality = (typeof EVIDENCE_QUALITIES)[number];

export const CEFR_SCORE: Record<CefrLevel, number> = {
  A1: 20,
  A2: 35,
  B1: 50,
  B2: 65,
  C1: 80,
  C2: 92,
};

const levels = Object.keys(CEFR_SCORE) as CefrLevel[];
const qualityRank: Record<EvidenceQuality, number> = {
  insufficient: 0,
  weak: 1,
  moderate: 2,
  strong: 3,
};

export type EvidenceDimensions = {
  accuracy: number;
  independence: number;
  range: number;
  complexity: number;
  consistency: number;
};

export type SkillEvidenceInput = {
  score: number;
  feedback: string;
  evidenceQuality: EvidenceQuality;
  dimensions: EvidenceDimensions | null;
  evidence: Array<{ learnerQuote: string; observation: string; independent: boolean }>;
};

export type CanonicalSkillAssessment = Omit<SkillEvidenceInput, 'dimensions'> & {
  dimensions: EvidenceDimensions;
  score: number;
  level: CefrLevel | null;
  confidence: number;
  highestTestedLevel: CefrLevel | null;
  evidenceCount: number;
};

export type CanonicalAssessment = {
  overallLevel: CefrLevel | null;
  levelRange: { from: CefrLevel; to: CefrLevel } | null;
  confidence: 'low' | 'medium' | 'high';
  evidenceSufficient: boolean;
  calibrationTarget: CefrLevel | null;
  basis: string;
  lessonPerformance: {
    taskLevel: CefrLevel;
    score: number;
    result: 'insufficient' | 'developing' | 'successful' | 'strong';
    evidenceQuality: EvidenceQuality;
    independence: number;
  };
  skills: Record<AssessmentSkill, CanonicalSkillAssessment>;
};

export type AssessmentTurn = { role: 'learner' | 'tutor'; text: string };

export function buildCanonicalAssessment(
  rawSkills: Record<AssessmentSkill, SkillEvidenceInput>,
  plan: PrivateLessonPlan,
  turns: AssessmentTurn[],
): CanonicalAssessment {
  const learnerTurns = turns.filter((turn) => turn.role === 'learner');
  const learnerText = learnerTurns.map((turn) => normalizeText(turn.text));
  const wordCount = learnerTurns.reduce((sum, turn) => sum + countWords(turn.text), 0);
  const taskLevel = taskLevelForPlan(plan);
  const legacyTenPointScale =
    Math.max(...ASSESSMENT_SKILLS.map((skill) => rawSkills[skill].score)) <= 10;
  const volumeQuality = qualityForVolume(wordCount, learnerTurns.length);

  const skills = Object.fromEntries(
    ASSESSMENT_SKILLS.map((skill) => {
      const raw = rawSkills[skill];
      const evidence = raw.evidence.filter((item) =>
        learnerText.some((turn) => turn.includes(normalizeText(item.learnerQuote))),
      );
      const evidenceQuality = lowerQuality(raw.evidenceQuality, volumeQuality);
      const dimensions =
        raw.dimensions ?? dimensionsFromLegacyScore(raw.score, legacyTenPointScale);
      const dimensionScore = weightedDimensionScore(dimensions);
      const evidenceCount = evidence.length;
      const quality = evidenceCount === 0 ? lowerQuality(evidenceQuality, 'weak') : evidenceQuality;
      const score = observedAbilityScore(taskLevel, dimensionScore, quality);
      return [
        skill,
        {
          ...raw,
          score,
          level: quality === 'insufficient' ? null : levelForScore(score),
          confidence: confidenceForQuality(quality, evidenceCount),
          highestTestedLevel: quality === 'insufficient' ? null : taskLevel,
          evidenceCount,
          evidenceQuality: quality,
          dimensions,
          evidence,
        },
      ];
    }),
  ) as Record<AssessmentSkill, CanonicalSkillAssessment>;

  const usableSkills = ASSESSMENT_SKILLS.filter(
    (skill) => qualityRank[skills[skill].evidenceQuality] >= qualityRank.moderate,
  );
  const independentEvidenceCount = ASSESSMENT_SKILLS.reduce(
    (sum, skill) => sum + skills[skill].evidence.filter((item) => item.independent).length,
    0,
  );
  const evidenceSufficient =
    wordCount >= 100 && usableSkills.length >= 3 && independentEvidenceCount >= 4;
  const overallScore = weightedOverallScore(skills);
  const strongestQuality = qualityForOverall(
    wordCount,
    usableSkills.length,
    independentEvidenceCount,
  );
  const confidence = evidenceSufficient
    ? strongestQuality === 'strong'
      ? 'high'
      : 'medium'
    : 'low';
  const overallLevel = evidenceSufficient ? levelForScore(overallScore) : null;
  const uncertainty = confidence === 'high' ? 5 : confidence === 'medium' ? 10 : 17;
  const levelRange =
    wordCount < 15
      ? null
      : {
          from: levelForScore(overallScore - uncertainty),
          to: levelForScore(overallScore + uncertainty),
        };
  const performanceScore = Math.round(
    ASSESSMENT_SKILLS.reduce(
      (sum, skill) => sum + weightedDimensionScore(skills[skill].dimensions),
      0,
    ) / ASSESSMENT_SKILLS.length,
  );
  const independence = Math.round(
    ASSESSMENT_SKILLS.reduce((sum, skill) => sum + skills[skill].dimensions.independence, 0) /
      ASSESSMENT_SKILLS.length,
  );

  return {
    overallLevel,
    levelRange,
    confidence,
    evidenceSufficient,
    calibrationTarget: nextLevel(levelRange?.to ?? taskLevel),
    basis: evidenceSufficient
      ? `Estimated from ${wordCount} learner words and ${independentEvidenceCount} independent evidence items across ${usableSkills.length} skills.`
      : `The lesson produced ${wordCount} learner words and ${independentEvidenceCount} independent evidence items. This is useful lesson evidence but not enough for a global CEFR decision.`,
    lessonPerformance: {
      taskLevel,
      score: performanceScore,
      result:
        wordCount < 15
          ? 'insufficient'
          : performanceScore >= 85
            ? 'strong'
            : performanceScore >= 70
              ? 'successful'
              : 'developing',
      evidenceQuality: strongestQuality,
      independence,
    },
    skills,
  };
}

export function taskLevelForPlan(plan: PrivateLessonPlan): CefrLevel {
  const topicKeys = plan.roadmap?.grammarTopics.length
    ? plan.roadmap.grammarTopics
    : plan.grammarFocus
      ? [plan.grammarFocus]
      : [];
  const topicLevels = topicKeys
    .map((key) => grammarTopics.find((topic) => topic.key === key)?.cefr as CefrLevel | undefined)
    .filter((level): level is CefrLevel => level !== undefined);
  if (topicLevels.length === 0) return plan.level;
  const baseLevel = topicLevels.reduce((highest, level) =>
    levelIndex(level) > levelIndex(highest) ? level : highest,
  );
  const independentStage =
    plan.roadmap?.milestoneKey === 'free-conversation' ||
    plan.roadmap?.milestoneKey === 'independent-mastery';
  return independentStage ? (nextLevel(baseLevel) ?? baseLevel) : baseLevel;
}

export function levelForScore(score: number): CefrLevel {
  if (score < 28) return 'A1';
  if (score < 43) return 'A2';
  if (score < 58) return 'B1';
  if (score < 73) return 'B2';
  if (score < 86) return 'C1';
  return 'C2';
}

export function nextLevel(level: CefrLevel): CefrLevel | null {
  return levels[levelIndex(level) + 1] ?? null;
}

export function levelIndex(level: CefrLevel) {
  return levels.indexOf(level);
}

export function qualityWeight(quality: EvidenceQuality) {
  return { insufficient: 0.04, weak: 0.08, moderate: 0.16, strong: 0.25 }[quality];
}

function observedAbilityScore(taskLevel: CefrLevel, performance: number, quality: EvidenceQuality) {
  if (quality === 'insufficient') return CEFR_SCORE[taskLevel];
  return clamp(Math.round(CEFR_SCORE[taskLevel] + (performance - 70) * 0.4), 0, 100);
}

function weightedDimensionScore(dimensions: EvidenceDimensions) {
  return (
    dimensions.accuracy * 0.3 +
    dimensions.independence * 0.25 +
    dimensions.range * 0.15 +
    dimensions.complexity * 0.15 +
    dimensions.consistency * 0.15
  );
}

function weightedOverallScore(skills: Record<AssessmentSkill, CanonicalSkillAssessment>) {
  return (
    skills.speaking.score * 0.3 +
    skills.comprehension.score * 0.2 +
    skills.grammar.score * 0.2 +
    skills.vocabulary.score * 0.15 +
    skills.fluency.score * 0.15
  );
}

function dimensionsFromLegacyScore(score: number, tenPointScale: boolean): EvidenceDimensions {
  const normalized = clamp(Math.round(tenPointScale ? score * 10 : score), 0, 100);
  return {
    accuracy: normalized,
    independence: Math.min(normalized, 60),
    range: Math.min(normalized, 55),
    complexity: Math.min(normalized, 55),
    consistency: normalized,
  };
}

function qualityForVolume(wordCount: number, turnCount: number): EvidenceQuality {
  if (wordCount < 15 || turnCount < 2) return 'insufficient';
  if (wordCount < 60 || turnCount < 5) return 'weak';
  if (wordCount < 140 || turnCount < 10) return 'moderate';
  return 'strong';
}

function qualityForOverall(
  wordCount: number,
  usableSkillCount: number,
  independentEvidenceCount: number,
): EvidenceQuality {
  if (wordCount < 15) return 'insufficient';
  if (wordCount < 60 || usableSkillCount < 2) return 'weak';
  if (wordCount < 140 || usableSkillCount < 4 || independentEvidenceCount < 7) return 'moderate';
  return 'strong';
}

function lowerQuality(left: EvidenceQuality, right: EvidenceQuality): EvidenceQuality {
  return qualityRank[left] <= qualityRank[right] ? left : right;
}

function confidenceForQuality(quality: EvidenceQuality, evidenceCount: number) {
  const base = { insufficient: 0.1, weak: 0.25, moderate: 0.5, strong: 0.7 }[quality];
  return Math.min(0.9, Number((base + Math.min(evidenceCount, 4) * 0.04).toFixed(2)));
}

function normalizeText(value: string) {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

function countWords(value: string) {
  return value.match(/\p{L}+(?:['’\-]\p{L}+)*/gu)?.length ?? 0;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(maximum, value));
}
