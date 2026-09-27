import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CefrLevel, ProfileScope } from '../profile/profile.types.js';
import {
  buildRoadmapBlueprint,
  privateLessonCurriculum,
  type PrivateLessonGoalKind,
} from './private-lesson.curriculum.js';
import type { PrivateLessonPlan } from './private-lesson.prompt.js';
import type { PrivateLessonReport } from './private-lesson.summary.js';
import type { PrivateLessonInput } from './private-lesson.validation.js';

export type PrivateLessonPreferences = Pick<
  PrivateLessonPlan,
  | 'supportLanguageCode'
  | 'teacherVoice'
  | 'speechRate'
  | 'focusAreas'
  | 'customFocus'
  | 'correctionMode'
  | 'vocabularyMode'
> & { requestedDurationMinutes: 1 | 5 | 10 | 15 };

export type PrivateLessonMilestone = {
  id: string;
  position: number;
  key: string;
  title: string;
  description: string;
  communicationObjective: string;
  grammarTopics: string[];
  successCriteria: { minimumLessons: number; targetScore: number };
  status: 'locked' | 'current' | 'completed';
  progressScore: number;
  evidenceLessonCount: number;
};

export type PrivateLessonRoadmap = {
  id: string;
  targetLanguageCode: string;
  goalKind: PrivateLessonGoalKind;
  goalKey: string;
  goalTitle: string;
  recommendedReason: string;
  status: 'active' | 'paused' | 'completed';
  currentMilestonePosition: number;
  milestones: PrivateLessonMilestone[];
};

export interface PrivateLessonRoadmapStore {
  getPreferences(
    scope: ProfileScope,
    targetLanguageCode: string,
  ): Promise<PrivateLessonPreferences | null>;
  savePreferences(
    scope: ProfileScope,
    input: PrivateLessonInput,
    plan: PrivateLessonPlan,
  ): Promise<void>;
  getActive(scope: ProfileScope, targetLanguageCode: string): Promise<PrivateLessonRoadmap | null>;
  create(
    scope: ProfileScope,
    targetLanguageCode: string,
    goalKind: PrivateLessonGoalKind,
    goalKey: string,
    level: CefrLevel,
  ): Promise<PrivateLessonRoadmap>;
  recordEvidence(
    scope: ProfileScope,
    lesson: PrivateLessonPlan,
    report: PrivateLessonReport,
  ): Promise<void>;
}

export class PostgresPrivateLessonRoadmapStore implements PrivateLessonRoadmapStore {
  constructor(private readonly pool: Pool) {}

  async getPreferences(scope: ProfileScope, targetLanguageCode: string) {
    const row = (
      await this.pool.query(
        `SELECT * FROM product_gotit.private_lesson_preferences WHERE application_id=$1 AND application_user_id=$2 AND target_language_code=$3`,
        [scope.applicationId, scope.applicationUserId, base(targetLanguageCode)],
      )
    ).rows[0];
    if (!row) return null;
    return {
      supportLanguageCode:
        typeof row.support_language_code === 'string' ? row.support_language_code : null,
      requestedDurationMinutes: Number(row.requested_duration_minutes) as 1 | 5 | 10 | 15,
      teacherVoice: row.teacher_voice,
      speechRate: row.speech_rate,
      focusAreas: row.focus_areas,
      customFocus: row.custom_focus,
      correctionMode: row.correction_mode,
      vocabularyMode: row.vocabulary_mode,
    } as PrivateLessonPreferences;
  }

  async savePreferences(scope: ProfileScope, input: PrivateLessonInput, plan: PrivateLessonPlan) {
    await this.pool.query(
      `INSERT INTO product_gotit.private_lesson_preferences(application_id,application_user_id,target_language_code,support_language_code,requested_duration_minutes,teacher_voice,speech_rate,correction_mode,vocabulary_mode,focus_areas,custom_focus)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
       ON CONFLICT(application_id,application_user_id,target_language_code) DO UPDATE SET support_language_code=EXCLUDED.support_language_code,requested_duration_minutes=EXCLUDED.requested_duration_minutes,teacher_voice=EXCLUDED.teacher_voice,speech_rate=EXCLUDED.speech_rate,correction_mode=EXCLUDED.correction_mode,vocabulary_mode=EXCLUDED.vocabulary_mode,focus_areas=EXCLUDED.focus_areas,custom_focus=EXCLUDED.custom_focus,updated_at=now()`,
      [
        scope.applicationId,
        scope.applicationUserId,
        base(input.targetLanguageCode),
        plan.supportLanguageCode,
        Math.round(plan.durationSeconds / 60),
        plan.teacherVoice,
        plan.speechRate,
        plan.correctionMode,
        plan.vocabularyMode,
        JSON.stringify(plan.focusAreas),
        plan.customFocus,
      ],
    );
  }

  async getActive(scope: ProfileScope, targetLanguageCode: string) {
    const roadmap = (
      await this.pool.query(
        `SELECT * FROM product_gotit.private_lesson_roadmaps WHERE application_id=$1 AND application_user_id=$2 AND target_language_code=$3 AND status='active'`,
        [scope.applicationId, scope.applicationUserId, base(targetLanguageCode)],
      )
    ).rows[0];
    if (!roadmap) return null;
    const milestones = (
      await this.pool.query(
        `SELECT * FROM product_gotit.private_lesson_milestones WHERE application_id=$1 AND application_user_id=$2 AND roadmap_id=$3 ORDER BY position`,
        [scope.applicationId, scope.applicationUserId, roadmap.id],
      )
    ).rows;
    return mapRoadmap(roadmap, milestones);
  }

  async create(
    scope: ProfileScope,
    targetLanguageCode: string,
    goalKind: PrivateLessonGoalKind,
    goalKey: string,
    level: CefrLevel,
  ) {
    const blueprint = buildRoadmapBlueprint(goalKind, goalKey, level);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        `${scope.applicationId}:${scope.applicationUserId}:${base(targetLanguageCode)}`,
      ]);
      const existing = await client.query(
        `SELECT id FROM product_gotit.private_lesson_roadmaps WHERE application_id=$1 AND application_user_id=$2 AND target_language_code=$3 AND status='active'`,
        [scope.applicationId, scope.applicationUserId, base(targetLanguageCode)],
      );
      if (goalKind === 'recommended' && existing.rows[0]) {
        await client.query('COMMIT');
        return (await this.getActive(scope, targetLanguageCode))!;
      }
      await client.query(
        `UPDATE product_gotit.private_lesson_roadmaps SET status='paused',updated_at=now() WHERE application_id=$1 AND application_user_id=$2 AND target_language_code=$3 AND status='active'`,
        [scope.applicationId, scope.applicationUserId, base(targetLanguageCode)],
      );
      const id = randomUUID();
      const roadmap = (
        await client.query(
          `INSERT INTO product_gotit.private_lesson_roadmaps(id,application_id,application_user_id,target_language_code,goal_kind,goal_key,goal_title,recommended_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [
            id,
            scope.applicationId,
            scope.applicationUserId,
            base(targetLanguageCode),
            blueprint.goalKind,
            blueprint.goalKey,
            blueprint.goalTitle,
            blueprint.recommendedReason,
          ],
        )
      ).rows[0];
      const milestones = [];
      for (const [index, milestone] of blueprint.milestones.entries()) {
        milestones.push(
          (
            await client.query(
              `INSERT INTO product_gotit.private_lesson_milestones(id,application_id,application_user_id,roadmap_id,position,milestone_key,title,description,communication_objective,grammar_topics,success_criteria,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12) RETURNING *`,
              [
                randomUUID(),
                scope.applicationId,
                scope.applicationUserId,
                id,
                index + 1,
                milestone.key,
                milestone.title,
                milestone.description,
                milestone.communicationObjective,
                JSON.stringify(milestone.grammarTopics),
                JSON.stringify(milestone.successCriteria),
                index === 0 ? 'current' : 'locked',
              ],
            )
          ).rows[0],
        );
      }
      await client.query('COMMIT');
      return mapRoadmap(roadmap, milestones);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async recordEvidence(
    scope: ProfileScope,
    lesson: PrivateLessonPlan,
    report: PrivateLessonReport,
  ) {
    if (!lesson.roadmap) return;
    const grammar = report.assessment.skills.grammar.score;
    const speaking = report.assessment.skills.speaking.score;
    const fluency = report.assessment.skills.fluency.score;
    const vocabulary = report.assessment.skills.vocabulary.score;
    const score = Math.round(grammar * 0.4 + speaking * 0.25 + fluency * 0.2 + vocabulary * 0.15);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO product_gotit.private_lesson_milestone_evidence(application_id,application_user_id,milestone_id,lesson_session_id,score,confidence) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [
          scope.applicationId,
          scope.applicationUserId,
          lesson.roadmap.milestoneId,
          lesson.id,
          score,
          report.assessment.confidence,
        ],
      );
      const stats = (
        await client.query(
          `SELECT round(avg(score))::int average_score,count(*)::int lesson_count FROM product_gotit.private_lesson_milestone_evidence WHERE application_id=$1 AND application_user_id=$2 AND milestone_id=$3`,
          [scope.applicationId, scope.applicationUserId, lesson.roadmap.milestoneId],
        )
      ).rows[0];
      const milestone = (
        await client.query(
          `UPDATE product_gotit.private_lesson_milestones SET progress_score=$4,evidence_lesson_count=$5,updated_at=now() WHERE application_id=$1 AND application_user_id=$2 AND id=$3 RETURNING *`,
          [
            scope.applicationId,
            scope.applicationUserId,
            lesson.roadmap.milestoneId,
            stats.average_score ?? 0,
            stats.lesson_count,
          ],
        )
      ).rows[0];
      const criteria = milestone.success_criteria as {
        minimumLessons: number;
        targetScore: number;
      };
      if (
        stats.lesson_count >= criteria.minimumLessons &&
        stats.average_score >= criteria.targetScore &&
        report.assessment.confidence !== 'low'
      ) {
        await advance(client, scope, lesson.roadmap.roadmapId, milestone.position);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

async function advance(
  client: PoolClient,
  scope: ProfileScope,
  roadmapId: string,
  position: number,
) {
  await client.query(
    `UPDATE product_gotit.private_lesson_milestones SET status='completed',progress_score=100,completed_at=now(),updated_at=now() WHERE application_id=$1 AND application_user_id=$2 AND roadmap_id=$3 AND position=$4`,
    [scope.applicationId, scope.applicationUserId, roadmapId, position],
  );
  const next = (
    await client.query(
      `UPDATE product_gotit.private_lesson_milestones SET status='current',updated_at=now() WHERE application_id=$1 AND application_user_id=$2 AND roadmap_id=$3 AND position=$4 RETURNING id`,
      [scope.applicationId, scope.applicationUserId, roadmapId, position + 1],
    )
  ).rowCount;
  if (next)
    await client.query(
      `UPDATE product_gotit.private_lesson_roadmaps SET current_milestone_position=$4,updated_at=now() WHERE application_id=$1 AND application_user_id=$2 AND id=$3`,
      [scope.applicationId, scope.applicationUserId, roadmapId, position + 1],
    );
  else
    await client.query(
      `UPDATE product_gotit.private_lesson_roadmaps SET status='completed',completed_at=now(),updated_at=now() WHERE application_id=$1 AND application_user_id=$2 AND id=$3`,
      [scope.applicationId, scope.applicationUserId, roadmapId],
    );
}

function mapRoadmap(
  row: Record<string, unknown>,
  milestones: Record<string, unknown>[],
): PrivateLessonRoadmap {
  return {
    id: String(row.id),
    targetLanguageCode: String(row.target_language_code),
    goalKind: row.goal_kind as PrivateLessonGoalKind,
    goalKey: String(row.goal_key),
    goalTitle: String(row.goal_title),
    recommendedReason: String(row.recommended_reason),
    status: row.status as PrivateLessonRoadmap['status'],
    currentMilestonePosition: Number(row.current_milestone_position),
    milestones: milestones.map((item) => ({
      id: String(item.id),
      position: Number(item.position),
      key: String(item.milestone_key),
      title: String(item.title),
      description: String(item.description),
      communicationObjective: String(item.communication_objective),
      grammarTopics: item.grammar_topics as string[],
      successCriteria: item.success_criteria as PrivateLessonMilestone['successCriteria'],
      status: item.status as PrivateLessonMilestone['status'],
      progressScore: Number(item.progress_score),
      evidenceLessonCount: Number(item.evidence_lesson_count),
    })),
  };
}

export function setupPayload(
  level: CefrLevel,
  preferences: PrivateLessonPreferences | null,
  roadmap: PrivateLessonRoadmap | null,
) {
  return { preferences, roadmap, curriculum: privateLessonCurriculum(level) };
}

const base = (languageCode: string) => new Intl.Locale(languageCode).language.toLowerCase();
