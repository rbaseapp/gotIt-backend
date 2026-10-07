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

export type PrivateLessonReportFailureCode =
  | 'provider_authentication'
  | 'provider_billing'
  | 'provider_permission'
  | 'provider_workspace'
  | 'provider_model_access'
  | 'provider_rate_limit'
  | 'provider_invalid_request'
  | 'provider_timeout'
  | 'provider_invalid_response'
  | 'provider_upstream'
  | 'output_limit'
  | 'content_filter'
  | 'incomplete_response'
  | 'refusal'
  | 'invalid_report'
  | 'generation_failed';

export interface PrivateLessonJournal {
  unitHistory?(scope: ProfileScope, packId: string): Promise<StoredPrivateLesson[]>;
  create(scope: ProfileScope, plan: PrivateLessonPlan): Promise<void>;
  get(scope: ProfileScope, id: string): Promise<StoredPrivateLesson | null>;
  list(
    scope: ProfileScope,
    limit: number,
    courseId?: string,
    packId?: string,
    targetLanguageCode?: string,
  ): Promise<StoredPrivateLesson[]>;
  claim(scope: ProfileScope, id: string, duration: number): Promise<StoredPrivateLesson | null>;
  complete(
    scope: ProfileScope,
    id: string,
    report: PrivateLessonReport,
  ): Promise<StoredPrivateLesson>;
  fail(scope: ProfileScope, id: string, errorCode: PrivateLessonReportFailureCode): Promise<void>;
  remove(scope: ProfileScope, id: string): Promise<boolean>;
}

export class PostgresPrivateLessonVocabularySource {
  constructor(private readonly pool: Pool) {}

  async learned(scope: ProfileScope, targetLanguageCode: string, count = 20) {
    const targetBaseLanguage = new Intl.Locale(targetLanguageCode).language.toLowerCase();
    const rows = (
      await this.pool.query(
        `SELECT li.id,li.source_text,li.source_language_code,
          (SELECT translation_text FROM product_gotit.item_translations t
           WHERE t.application_id=li.application_id
             AND t.application_user_id=li.application_user_id
             AND t.learning_item_id=li.id AND t.is_current AND t.is_primary
           ORDER BY t.id LIMIT 1) AS primary_translation
         FROM product_gotit.learning_items li
         WHERE li.application_id=$1 AND li.application_user_id=$2
           AND li.user_status='active' AND li.learning_status='mastered'
           AND li.deleted_at IS NULL
           AND split_part(replace(lower(li.source_language_code),'_','-'),'-',1)=$3
         ORDER BY li.next_review_at ASC NULLS FIRST,li.updated_at ASC,li.id
         LIMIT $4`,
        [scope.applicationId, scope.applicationUserId, targetBaseLanguage, count],
      )
    ).rows;
    return {
      items: rows
        .filter((row) => typeof row.primary_translation === 'string')
        .map((row) => ({
          id: String(row.id),
          sourceText: String(row.source_text),
          sourceLanguageCode: String(row.source_language_code),
          primaryTranslation: String(row.primary_translation),
        })),
    };
  }
}

export class PostgresPrivateLessonJournal implements PrivateLessonJournal {
  constructor(private readonly pool: Pool) {}

  async unitHistory(scope: ProfileScope, packId: string) {
    // Three canonical checkpoints, independent of history pagination and repeated calls.
    const rows = (
      await this.pool.query(
        `${selectFields}
      WHERE s.application_id=$1 AND s.application_user_id=$2 AND s.deleted_at IS NULL
        AND s.word_pack_context->>'packId'=$3 AND s.status='completed'
        AND s.report->'assessment'->'lessonPerformance'->>'evidenceQuality'<>'insufficient'
      ORDER BY s.started_at ASC,s.id ASC`,
        [scope.applicationId, scope.applicationUserId, packId],
      )
    ).rows;
    return rows.map(storedLesson);
  }

  async create(scope: ProfileScope, plan: PrivateLessonPlan) {
    await this.pool.query(
      `INSERT INTO product_gotit.private_lesson_sessions
       (id,application_id,application_user_id,target_language_code,support_language_code,level,topic,
        grammar_focus,focus_areas,custom_focus,correction_mode,vocabulary_mode,lesson_mode,teaching_language,continuity,teacher_voice,speech_rate,
        planned_duration_seconds,target_words,roadmap_id,milestone_id,course_context,word_pack_context)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19::jsonb,$20,$21,$22::jsonb,$23::jsonb)`,
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
        plan.correctionMode,
        plan.vocabularyMode,
        plan.lessonMode,
        plan.teachingLanguage ?? (plan.lessonMode === 'absolute_beginner' ? 'support' : 'target'),
        plan.continuity ? JSON.stringify(plan.continuity) : null,
        plan.teacherVoice,
        plan.speechRate,
        plan.durationSeconds,
        JSON.stringify(plan.targets),
        plan.roadmap?.roadmapId ?? null,
        plan.roadmap?.milestoneId ?? null,
        plan.course ? JSON.stringify(plan.course) : null,
        plan.wordPack ? JSON.stringify(plan.wordPack) : null,
      ],
    );
  }

  async get(scope: ProfileScope, id: string) {
    const row = (
      await this.pool.query(
        `${selectFields} WHERE s.application_id=$1 AND s.application_user_id=$2 AND s.id=$3 AND s.deleted_at IS NULL`,
        [scope.applicationId, scope.applicationUserId, id],
      )
    ).rows[0];
    return row ? storedLesson(row) : null;
  }

  async list(
    scope: ProfileScope,
    limit: number,
    courseId?: string,
    packId?: string,
    targetLanguageCode?: string,
  ) {
    const rows = (
      await this.pool.query(
        `${selectFields} WHERE s.application_id=$1 AND s.application_user_id=$2 AND s.deleted_at IS NULL
           AND s.status<>'active'
           AND ($4::uuid IS NULL OR s.course_context->>'courseId'=$4::text)
           AND ($5::uuid IS NULL OR s.word_pack_context->>'packId'=$5::text)
           AND ($6::text IS NULL OR lower(split_part(s.target_language_code,'-',1))=$6)
         ORDER BY s.started_at DESC,s.id DESC LIMIT $3`,
        [
          scope.applicationId,
          scope.applicationUserId,
          limit,
          courseId ?? null,
          packId ?? null,
          targetLanguageCode ? new Intl.Locale(targetLanguageCode).language.toLowerCase() : null,
        ],
      )
    ).rows;
    return rows.map(storedLesson);
  }

  async claim(scope: ProfileScope, id: string, duration: number) {
    const updated = (
      await this.pool.query(
        `UPDATE product_gotit.private_lesson_sessions SET status='summarizing',ended_at=COALESCE(ended_at,now()),
         actual_duration_seconds=$4,updated_at=now()
         WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL
           AND (status IN('active','report_failed') OR
             (status='summarizing' AND updated_at < now()-interval '2 minutes')) RETURNING id`,
        [scope.applicationId, scope.applicationUserId, id, duration],
      )
    ).rows[0];
    return updated ? await this.get(scope, id) : null;
  }

  async complete(scope: ProfileScope, id: string, report: PrivateLessonReport) {
    const updated = (
      await this.pool.query(
        `WITH finished AS (UPDATE product_gotit.private_lesson_sessions SET status='completed',report=$4::jsonb,
         report_generated_at=now(),report_error_code=NULL,updated_at=now()
         WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL
         RETURNING id), purged AS (DELETE FROM product_gotit.private_lesson_activities a USING finished
           WHERE a.application_id=$1 AND a.application_user_id=$2 AND a.lesson_id=finished.id RETURNING a.lesson_id)
         SELECT id FROM finished`,
        [scope.applicationId, scope.applicationUserId, id, JSON.stringify(report)],
      )
    ).rows[0];
    if (!updated) throw notFound();
    const lesson = await this.get(scope, id);
    if (!lesson) throw notFound();
    return lesson;
  }

  async fail(scope: ProfileScope, id: string, errorCode: PrivateLessonReportFailureCode) {
    await this.pool.query(
      `UPDATE product_gotit.private_lesson_sessions SET status='report_failed',report_error_code=$4,updated_at=now()
       WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL`,
      [scope.applicationId, scope.applicationUserId, id, errorCode],
    );
  }

  async remove(scope: ProfileScope, id: string) {
    return Boolean(
      (
        await this.pool.query(
          `WITH removed AS (UPDATE product_gotit.private_lesson_sessions SET deleted_at=now(),updated_at=now()
           WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL RETURNING id),
           purged AS (DELETE FROM product_gotit.private_lesson_activities a USING removed
             WHERE a.application_id=$1 AND a.application_user_id=$2 AND a.lesson_id=removed.id RETURNING a.lesson_id)
           SELECT id FROM removed`,
          [scope.applicationId, scope.applicationUserId, id],
        )
      ).rowCount,
    );
  }
}

const selectFields = `SELECT s.id,s.target_language_code,s.support_language_code,s.level,s.topic,s.grammar_focus,
 s.focus_areas,s.custom_focus,s.correction_mode,s.vocabulary_mode,s.lesson_mode,s.teaching_language,s.continuity,s.roadmap_id,s.milestone_id,s.course_context,s.word_pack_context,
 s.teacher_voice,s.speech_rate,s.planned_duration_seconds,s.target_words,s.status,s.started_at,s.ended_at,
 s.actual_duration_seconds,s.report,r.goal_title,m.milestone_key,m.communication_objective,m.grammar_topics,
 m.success_criteria,m.evidence_lesson_count
 FROM product_gotit.private_lesson_sessions s
 LEFT JOIN product_gotit.private_lesson_roadmaps r
   ON r.application_id=s.application_id AND r.application_user_id=s.application_user_id AND r.id=s.roadmap_id
 LEFT JOIN product_gotit.private_lesson_milestones m
   ON m.application_id=s.application_id AND m.application_user_id=s.application_user_id AND m.id=s.milestone_id`;

function storedLesson(row: Record<string, unknown>): StoredPrivateLesson {
  const level = row.level as StoredPrivateLesson['level'];
  const rawReport =
    row.report && typeof row.report === 'object' ? (row.report as Record<string, unknown>) : null;
  return {
    course: (row.course_context as PrivateLessonPlan['course']) ?? null,
    wordPack: (row.word_pack_context as PrivateLessonPlan['wordPack']) ?? null,
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
    correctionMode:
      row.correction_mode === 'critical_only' || row.correction_mode === 'deep_explanation'
        ? row.correction_mode
        : 'recast',
    vocabularyMode: row.vocabulary_mode === 'none' ? 'none' : 'learned',
    lessonMode: row.lesson_mode === 'absolute_beginner' ? 'absolute_beginner' : 'standard',
    teachingLanguage: row.teaching_language === 'support' ? 'support' : 'target',
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
    roadmap:
      typeof row.roadmap_id === 'string' && typeof row.milestone_id === 'string'
        ? {
            roadmapId: row.roadmap_id,
            milestoneId: row.milestone_id,
            milestoneKey: typeof row.milestone_key === 'string' ? row.milestone_key : '',
            goalTitle: typeof row.goal_title === 'string' ? row.goal_title : '',
            communicationObjective:
              typeof row.communication_objective === 'string' ? row.communication_objective : '',
            grammarTopics: Array.isArray(row.grammar_topics)
              ? (row.grammar_topics as string[])
              : [],
            successCriteria:
              row.success_criteria && typeof row.success_criteria === 'object'
                ? (row.success_criteria as NonNullable<
                    PrivateLessonPlan['roadmap']
                  >['successCriteria'])
                : { minimumLessons: 2, targetScore: 75 },
            evidenceLessonCount: Number(row.evidence_lesson_count ?? 0),
            isFirstMilestoneLesson: Number(row.evidence_lesson_count ?? 0) === 0,
          }
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
