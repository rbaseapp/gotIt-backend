import type { Pool } from 'pg';
import { AppError } from '../../shared/errors/app-error.js';
import type { ProfileScope } from '../profile/profile.types.js';
import type { PrivateLessonPlan } from './private-lesson.prompt.js';
import {
  lowConfidenceAssessment,
  privateLessonReportSchema,
  type PrivateLessonReport,
} from './private-lesson.summary.js';

export type StoredPrivateLesson = PrivateLessonPlan & {
  status: 'active' | 'summarizing' | 'completed' | 'report_failed';
  startedAt: string;
  endedAt: string | null;
  actualDurationSeconds: number | null;
  report: PrivateLessonReport | null;
};

export interface PrivateLessonJournal {
  create(scope: ProfileScope, plan: PrivateLessonPlan): Promise<void>;
  get(scope: ProfileScope, id: string): Promise<StoredPrivateLesson | null>;
  list(scope: ProfileScope, limit: number): Promise<StoredPrivateLesson[]>;
  claim(scope: ProfileScope, id: string, duration: number): Promise<StoredPrivateLesson | null>;
  complete(
    scope: ProfileScope,
    id: string,
    report: PrivateLessonReport,
  ): Promise<StoredPrivateLesson>;
  fail(scope: ProfileScope, id: string): Promise<void>;
  remove(scope: ProfileScope, id: string): Promise<boolean>;
}

export class PostgresPrivateLessonJournal implements PrivateLessonJournal {
  constructor(private readonly pool: Pool) {}

  async create(scope: ProfileScope, plan: PrivateLessonPlan) {
    await this.pool.query(
      `INSERT INTO product_gotit.private_lesson_sessions
       (id,application_id,application_user_id,target_language_code,support_language_code,level,topic,
        grammar_focus,focus_areas,custom_focus,continuity,teacher_voice,speech_rate,
        planned_duration_seconds,target_words)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15::jsonb)`,
      [
        plan.id,
        scope.applicationId,
        scope.applicationUserId,
        plan.targetLanguageCode,
        plan.supportLanguageCode,
        plan.level,
        plan.topic,
        plan.grammarFocus,
        JSON.stringify(plan.focusAreas),
        plan.customFocus,
        plan.continuity ? JSON.stringify(plan.continuity) : null,
        plan.teacherVoice,
        plan.speechRate,
        plan.durationSeconds,
        JSON.stringify(plan.targets),
      ],
    );
  }

  async get(scope: ProfileScope, id: string) {
    const row = (
      await this.pool.query(
        `${selectFields} WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL`,
        [scope.applicationId, scope.applicationUserId, id],
      )
    ).rows[0];
    return row ? storedLesson(row) : null;
  }

  async list(scope: ProfileScope, limit: number) {
    const rows = (
      await this.pool.query(
        `${selectFields} WHERE application_id=$1 AND application_user_id=$2 AND deleted_at IS NULL
           AND status<>'active'
         ORDER BY started_at DESC,id DESC LIMIT $3`,
        [scope.applicationId, scope.applicationUserId, limit],
      )
    ).rows;
    return rows.map(storedLesson);
  }

  async claim(scope: ProfileScope, id: string, duration: number) {
    const row = (
      await this.pool.query(
        `UPDATE product_gotit.private_lesson_sessions SET status='summarizing',ended_at=COALESCE(ended_at,now()),
         actual_duration_seconds=$4,updated_at=now()
         WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL
           AND (status IN('active','report_failed') OR
             (status='summarizing' AND updated_at < now()-interval '2 minutes')) RETURNING *`,
        [scope.applicationId, scope.applicationUserId, id, duration],
      )
    ).rows[0];
    return row ? storedLesson(row) : null;
  }

  async complete(scope: ProfileScope, id: string, report: PrivateLessonReport) {
    const row = (
      await this.pool.query(
        `UPDATE product_gotit.private_lesson_sessions SET status='completed',report=$4::jsonb,
         report_generated_at=now(),report_error_code=NULL,updated_at=now()
         WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL
         RETURNING *`,
        [scope.applicationId, scope.applicationUserId, id, JSON.stringify(report)],
      )
    ).rows[0];
    if (!row) throw notFound();
    return storedLesson(row);
  }

  async fail(scope: ProfileScope, id: string) {
    await this.pool.query(
      `UPDATE product_gotit.private_lesson_sessions SET status='report_failed',report_error_code='generation_failed',updated_at=now()
       WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL`,
      [scope.applicationId, scope.applicationUserId, id],
    );
  }

  async remove(scope: ProfileScope, id: string) {
    return Boolean(
      (
        await this.pool.query(
          `UPDATE product_gotit.private_lesson_sessions SET deleted_at=now(),updated_at=now()
           WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL RETURNING id`,
          [scope.applicationId, scope.applicationUserId, id],
        )
      ).rowCount,
    );
  }
}

const selectFields = `SELECT id,target_language_code,support_language_code,level,topic,grammar_focus,
 focus_areas,custom_focus,continuity,
 teacher_voice,speech_rate,planned_duration_seconds,target_words,status,started_at,ended_at,
 actual_duration_seconds,report FROM product_gotit.private_lesson_sessions`;

function storedLesson(row: Record<string, unknown>): StoredPrivateLesson {
  const level = row.level as StoredPrivateLesson['level'];
  const rawReport =
    row.report && typeof row.report === 'object' ? (row.report as Record<string, unknown>) : null;
  return {
    id: String(row.id),
    durationSeconds: Number(row.planned_duration_seconds),
    targetLanguageCode: String(row.target_language_code),
    supportLanguageCode:
      typeof row.support_language_code === 'string' ? row.support_language_code : null,
    level,
    topic: String(row.topic),
    grammarFocus: typeof row.grammar_focus === 'string' ? row.grammar_focus : null,
    focusAreas: Array.isArray(row.focus_areas)
      ? (row.focus_areas as PrivateLessonPlan['focusAreas'])
      : ['speaking', 'vocabulary'],
    customFocus: typeof row.custom_focus === 'string' ? row.custom_focus : null,
    teacherVoice: row.teacher_voice as StoredPrivateLesson['teacherVoice'],
    speechRate: row.speech_rate as StoredPrivateLesson['speechRate'],
    interests: [],
    targets: Array.isArray(row.target_words)
      ? (row.target_words as PrivateLessonPlan['targets'])
      : [],
    continuity:
      row.continuity && typeof row.continuity === 'object'
        ? (row.continuity as PrivateLessonPlan['continuity'])
        : null,
    status: row.status as StoredPrivateLesson['status'],
    startedAt: new Date(row.started_at as string | Date).toISOString(),
    endedAt: row.ended_at ? new Date(row.ended_at as string | Date).toISOString() : null,
    actualDurationSeconds:
      typeof row.actual_duration_seconds === 'number' ? row.actual_duration_seconds : null,
    report: rawReport
      ? privateLessonReportSchema.parse({
          ...rawReport,
          assessment: rawReport.assessment ?? lowConfidenceAssessment(level),
        })
      : null,
  };
}

export const privateLessonNotFound = () =>
  new AppError(404, 'PRIVATE_LESSON_NOT_FOUND', 'Private lesson not found');
const notFound = privateLessonNotFound;
