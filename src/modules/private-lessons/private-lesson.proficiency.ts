import type { Pool, PoolClient } from 'pg';
import type { CefrLevel, ProfileScope } from '../profile/profile.types.js';
import {
  ASSESSMENT_SKILLS,
  CEFR_SCORE,
  levelForScore,
  levelIndex,
  nextLevel,
  qualityWeight,
  type AssessmentSkill,
} from './private-lesson.assessment.js';
import type { PrivateLessonPlan } from './private-lesson.prompt.js';
import type { PrivateLessonReport } from './private-lesson.summary.js';

type SkillProfileRow = {
  skill: AssessmentSkill;
  ability_score: number | string;
  confidence: number | string;
  evidence_count: number;
  strong_evidence_count: number;
  highest_tested_level: CefrLevel | null;
  below_level_evidence_count: number;
};

type LanguageProfileRow = {
  self_assessed_level: CefrLevel | null;
  system_estimated_level: CefrLevel | null;
  effective_level: CefrLevel | null;
};

export interface PrivateLessonProficiencyStore {
  recordLessonEvidence(
    scope: ProfileScope,
    lesson: PrivateLessonPlan,
    report: PrivateLessonReport,
  ): Promise<void>;
}

/**
 * Accumulates calibrated, per-skill evidence. A single lesson can improve a skill estimate,
 * but promotion needs two broad lessons and a downgrade needs three on-level failures.
 */
export class PostgresPrivateLessonProficiencyStore implements PrivateLessonProficiencyStore {
  constructor(private readonly pool: Pool) {}

  async recordLessonEvidence(
    scope: ProfileScope,
    lesson: PrivateLessonPlan,
    report: PrivateLessonReport,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const skill of ASSESSMENT_SKILLS)
        await recordSkill(client, scope, lesson, report, skill);
      await updateLanguageEstimate(client, scope, lesson.targetLanguageCode);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

async function recordSkill(
  client: PoolClient,
  scope: ProfileScope,
  lesson: PrivateLessonPlan,
  report: PrivateLessonReport,
  skill: AssessmentSkill,
) {
  const assessment = report.assessment.skills[skill];
  const taskLevel = report.assessment.lessonPerformance.taskLevel;
  const inserted = await client.query(
    `INSERT INTO product_gotit.private_lesson_skill_evidence
      (application_id,application_user_id,lesson_session_id,language_code,skill,task_level,observed_score,evidence_weight,evidence_quality,dimensions,evidence)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb)
     ON CONFLICT DO NOTHING RETURNING skill`,
    [
      scope.applicationId,
      scope.applicationUserId,
      lesson.id,
      baseLanguage(lesson.targetLanguageCode),
      skill,
      taskLevel,
      assessment.score,
      qualityWeight(assessment.evidenceQuality),
      assessment.evidenceQuality,
      JSON.stringify(assessment.dimensions),
      JSON.stringify(assessment.evidence),
    ],
  );
  if (inserted.rowCount === 0) return;

  const existing = (
    await client.query<SkillProfileRow>(
      `SELECT skill,ability_score,confidence,evidence_count,strong_evidence_count,highest_tested_level,below_level_evidence_count
       FROM product_gotit.private_lesson_skill_profiles
       WHERE application_id=$1 AND application_user_id=$2 AND language_code=$3 AND skill=$4
       FOR UPDATE`,
      [scope.applicationId, scope.applicationUserId, baseLanguage(lesson.targetLanguageCode), skill],
    )
  ).rows[0];
  const priorScore = existing ? Number(existing.ability_score) : assessment.score;
  const priorLevel = levelForScore(priorScore);
  const successfulLowerTask =
    levelIndex(taskLevel) < levelIndex(priorLevel) &&
    report.assessment.lessonPerformance.score >= 70;
  const observation = successfulLowerTask
    ? Math.max(priorScore, assessment.score)
    : assessment.score;
  const alpha = qualityWeight(assessment.evidenceQuality);
  const abilityScore = existing
    ? round2(priorScore + alpha * (observation - priorScore))
    : round2(observation);
  const confidence = existing
    ? round2(1 - (1 - Number(existing.confidence)) * (1 - alpha * 0.65))
    : round2(Math.max(0.08, alpha * 2));
  const highestTestedLevel = higherLevel(existing?.highest_tested_level ?? null, taskLevel);
  const testedAtPriorLevel = levelIndex(taskLevel) >= levelIndex(priorLevel);
  const belowLevelEvidenceCount =
    testedAtPriorLevel && assessment.score < CEFR_SCORE[priorLevel] - 7
      ? (existing?.below_level_evidence_count ?? 0) + 1
      : 0;

  await client.query(
    `INSERT INTO product_gotit.private_lesson_skill_profiles
      (application_id,application_user_id,language_code,skill,ability_score,confidence,evidence_count,strong_evidence_count,highest_tested_level,below_level_evidence_count,last_lesson_session_id)
     VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,$9,$10)
     ON CONFLICT(application_id,application_user_id,language_code,skill) DO UPDATE SET
       ability_score=EXCLUDED.ability_score,
       confidence=EXCLUDED.confidence,
       evidence_count=product_gotit.private_lesson_skill_profiles.evidence_count+1,
       strong_evidence_count=product_gotit.private_lesson_skill_profiles.strong_evidence_count+EXCLUDED.strong_evidence_count,
       highest_tested_level=EXCLUDED.highest_tested_level,
       below_level_evidence_count=EXCLUDED.below_level_evidence_count,
       last_lesson_session_id=EXCLUDED.last_lesson_session_id,
       updated_at=now()`,
    [
      scope.applicationId,
      scope.applicationUserId,
      baseLanguage(lesson.targetLanguageCode),
      skill,
      abilityScore,
      confidence,
      assessment.evidenceQuality === 'strong' ? 1 : 0,
      highestTestedLevel,
      belowLevelEvidenceCount,
      lesson.id,
    ],
  );
}

async function updateLanguageEstimate(
  client: PoolClient,
  scope: ProfileScope,
  languageCode: string,
) {
  const language = baseLanguage(languageCode);
  const profiles = (
    await client.query<SkillProfileRow>(
      `SELECT skill,ability_score,confidence,evidence_count,strong_evidence_count,highest_tested_level,below_level_evidence_count
       FROM product_gotit.private_lesson_skill_profiles
       WHERE application_id=$1 AND application_user_id=$2 AND language_code=$3`,
      [scope.applicationId, scope.applicationUserId, language],
    )
  ).rows;
  if (profiles.length === 0) return;
  const bySkill = new Map(profiles.map((profile) => [profile.skill, profile]));
  const lessonCount = Number(
    (
      await client.query(
        `SELECT count(DISTINCT lesson_session_id)::int lesson_count
         FROM product_gotit.private_lesson_skill_evidence
         WHERE application_id=$1 AND application_user_id=$2 AND language_code=$3`,
        [scope.applicationId, scope.applicationUserId, language],
      )
    ).rows[0]?.lesson_count ?? 0,
  );
  const current = (
    await client.query<LanguageProfileRow>(
      `SELECT self_assessed_level,system_estimated_level,effective_level
       FROM product_gotit.user_language_proficiencies
       WHERE application_id=$1 AND application_user_id=$2 AND language_code=$3
       FOR UPDATE`,
      [scope.applicationId, scope.applicationUserId, language],
    )
  ).rows[0];
  if (!current) return;

  const score = weightedProfileScore(bySkill);
  const candidate = levelForScore(score);
  const averageConfidence = round2(
    profiles.reduce((sum, profile) => sum + Number(profile.confidence), 0) / profiles.length,
  );
  const broadEvidence =
    lessonCount >= 2 &&
    profiles.length >= 4 &&
    (bySkill.get('speaking')?.evidence_count ?? 0) >= 2 &&
    (bySkill.get('comprehension')?.evidence_count ?? 0) >= 2 &&
    averageConfidence >= 0.35;
  const existingLevel =
    current.effective_level ?? current.self_assessed_level ?? current.system_estimated_level;
  const promotion =
    broadEvidence && (!existingLevel || levelIndex(candidate) >= levelIndex(existingLevel));
  const downgrade =
    broadEvidence &&
    lessonCount >= 3 &&
    Boolean(existingLevel) &&
    levelIndex(candidate) < levelIndex(existingLevel!) &&
    ['speaking', 'grammar', 'comprehension'].every(
      (skill) => (bySkill.get(skill as AssessmentSkill)?.below_level_evidence_count ?? 0) >= 3,
    );
  const canChangeEffectiveLevel = promotion || downgrade;
  const margin = averageConfidence >= 0.7 ? 6 : averageConfidence >= 0.45 ? 11 : 17;
  const from = levelForScore(score - margin);
  const to = levelForScore(score + margin);
  const calibrationTarget = nextLevel(highestTested(profiles)) ?? highestTested(profiles);

  await client.query(
    `UPDATE product_gotit.user_language_proficiencies SET
       system_estimated_level=CASE WHEN $4 THEN $5 ELSE system_estimated_level END,
       effective_level=CASE WHEN $6 THEN $5 ELSE COALESCE(effective_level,self_assessed_level) END,
       system_confidence=$7,
       estimated_level_lower=$8,
       estimated_level_upper=$9,
       assessment_evidence_count=$10,
       calibration_target=$11,
       last_evaluated_at=now(),
       updated_at=now()
     WHERE application_id=$1 AND application_user_id=$2 AND language_code=$3`,
    [
      scope.applicationId,
      scope.applicationUserId,
      language,
      broadEvidence,
      candidate,
      canChangeEffectiveLevel,
      averageConfidence,
      from,
      to,
      lessonCount,
      calibrationTarget,
    ],
  );
}

function weightedProfileScore(profiles: Map<AssessmentSkill, SkillProfileRow>) {
  const weights: Record<AssessmentSkill, number> = {
    speaking: 0.3,
    comprehension: 0.2,
    grammar: 0.2,
    vocabulary: 0.15,
    fluency: 0.15,
  };
  let weight = 0;
  let score = 0;
  for (const skill of ASSESSMENT_SKILLS) {
    const profile = profiles.get(skill);
    if (!profile) continue;
    score += Number(profile.ability_score) * weights[skill];
    weight += weights[skill];
  }
  return weight === 0 ? CEFR_SCORE.A2 : score / weight;
}

function highestTested(profiles: SkillProfileRow[]) {
  return profiles.reduce<CefrLevel>((highest, profile) => {
    const tested = profile.highest_tested_level;
    return tested && levelIndex(tested) > levelIndex(highest) ? tested : highest;
  }, 'A1');
}

function higherLevel(left: CefrLevel | null, right: CefrLevel) {
  return !left || levelIndex(right) > levelIndex(left) ? right : left;
}

function baseLanguage(value: string) {
  return new Intl.Locale(value).language;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}
