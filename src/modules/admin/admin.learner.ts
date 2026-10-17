import { z } from 'zod';
import type { DatabaseTransaction } from '../../shared/database/transaction.js';
import { ProfileRepository } from '../profile/profile.repository.js';
import { PROFILE_DEFAULTS } from '../profile/profile.constants.js';
import { normalizePatch } from '../profile/profile.service.js';
import { profilePatchSchema } from '../profile/profile.validation.js';
import { publicCourse, homeworkSummary } from '../courses/course.service.js';
import type { CourseDocument, HomeworkDocument } from '../courses/course.schemas.js';
import type { ProfileScope } from '../profile/profile.types.js';
import { AppError } from '../../shared/errors/app-error.js';
import { preferencePatchSchema } from '../notifications/notification.policy.js';
import { privateLessonPreferencesInputSchema } from '../private-lessons/private-lesson.validation.js';

export const learnerPageSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    perPage: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();
export const learnerSectionSchema = z.enum([
  'overview',
  'activity',
  'games',
  'sessions',
  'attempts',
  'xp',
  'lessons',
  'courses',
  'homework',
  'roadmaps',
  'packs',
  'usage',
]);
export const learnerProfileSchema = z
  .object({
    operationId: z.uuid(),
    reason: z.string().trim().min(3).max(1000),
    expectedRevision: z.string().min(1).max(100),
    changes: profilePatchSchema,
  })
  .strict();
const settingsCommand = {
  operationId: z.uuid(),
  reason: z.string().trim().min(3).max(1000),
  expectedRevision: z.string().min(1).max(100).nullable(),
};
export const learnerSettingsSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...settingsCommand,
      kind: z.literal('notifications'),
      changes: preferencePatchSchema,
    })
    .strict(),
  z
    .object({
      ...settingsCommand,
      kind: z.literal('lesson'),
      changes: privateLessonPreferencesInputSchema,
    })
    .strict(),
]);

// Practice seconds are the server's bounded active-answer accounting. Lesson seconds
// are recorded duration, attributed to the lesson's start day in the profile timezone.
const daily = `WITH profile AS (SELECT timezone FROM product_gotit.user_profiles WHERE application_id=$1 AND application_user_id=$2),
  events AS (
    SELECT activity_date AS day,practice_seconds::bigint AS practice,0::bigint AS lesson,attempts::bigint AS attempts,correct_attempts::bigint AS correct,sessions_completed::bigint AS sessions,0::bigint AS lessons,xp_earned::bigint AS xp FROM product_gotit.user_daily_activity WHERE application_id=$1 AND application_user_id=$2
    UNION ALL SELECT (started_at AT TIME ZONE COALESCE((SELECT timezone FROM profile),'UTC'))::date,0,COALESCE(actual_duration_seconds,0),0,0,0,1,0 FROM product_gotit.private_lesson_sessions WHERE application_id=$1 AND application_user_id=$2
    UNION ALL SELECT (started_at AT TIME ZONE COALESCE((SELECT timezone FROM profile),'UTC'))::date,0,0,0,0,0,0,0 FROM product_gotit.practice_sessions WHERE application_id=$1 AND application_user_id=$2
    UNION ALL SELECT (created_at AT TIME ZONE COALESCE((SELECT timezone FROM profile),'UTC'))::date,0,0,0,0,0,0,0 FROM product_gotit.learning_items WHERE application_id=$1 AND application_user_id=$2
    UNION ALL SELECT (created_at AT TIME ZONE COALESCE((SELECT timezone FROM profile),'UTC'))::date,0,0,0,0,0,0,0 FROM product_gotit.learning_documents WHERE application_id=$1 AND application_user_id=$2
  ) SELECT day::text AS id,day::text AS date,sum(practice)::float8 AS "practiceSeconds",sum(lesson)::float8 AS "lessonSeconds",sum(practice+lesson)::float8 AS "measuredSeconds",sum(attempts)::int AS attempts,sum(correct)::int AS "correctAttempts",sum(sessions)::int AS "completedSessions",sum(lessons)::int AS lessons,sum(xp)::float8 AS xp FROM events GROUP BY day`;

const sources = {
  activity: daily,
  sessions: `SELECT id,session_type AS game,status,started_at AS "startedAt",ended_at AS "endedAt",duration_seconds AS "elapsedSeconds",attempt_count AS attempts,correct_count AS "correctAttempts",xp_earned AS xp FROM product_gotit.practice_sessions WHERE application_id=$1 AND application_user_id=$2`,
  attempts: `SELECT a.id,a.practice_session_id AS "sessionId",a.learning_item_id AS "itemId",i.source_text AS word,a.user_answer_text AS answer,a.exercise_type AS game,a.result,a.score::float8 AS score,a.response_time_ms AS "responseTimeMs",a.hints_used AS hints,a.created_at AS "createdAt" FROM product_gotit.practice_attempts a JOIN product_gotit.learning_items i ON i.application_id=a.application_id AND i.application_user_id=a.application_user_id AND i.id=a.learning_item_id WHERE a.application_id=$1 AND a.application_user_id=$2`,
  xp: `SELECT id,source_type AS source,source_id AS "sourceId",xp_amount AS xp,reason_code AS reason,created_at AS "createdAt" FROM product_gotit.xp_events WHERE application_id=$1 AND application_user_id=$2`,
  lessons: `SELECT id,target_language_code AS language,level,topic,status,lesson_mode AS mode,planned_duration_seconds AS "plannedSeconds",actual_duration_seconds AS "actualSeconds",started_at AS "startedAt",ended_at AS "endedAt",deleted_at AS "deletedAt",roadmap_id AS "roadmapId",milestone_id AS "milestoneId",report,report_error_code AS "reportError" FROM product_gotit.private_lesson_sessions WHERE application_id=$1 AND application_user_id=$2`,
  courses: `SELECT id,revision,created_at AS "createdAt",document FROM product_gotit.learning_documents WHERE application_id=$1 AND application_user_id=$2 AND kind='course'`,
  homework: `SELECT id,revision,created_at AS "createdAt",document FROM product_gotit.learning_documents WHERE application_id=$1 AND application_user_id=$2 AND kind='homework'`,
  roadmaps: `SELECT r.id,r.target_language_code AS language,r.goal_title AS title,r.status,r.current_milestone_position AS "currentMilestone",r.created_at AS "createdAt",r.completed_at AS "completedAt",(SELECT COALESCE(jsonb_agg(jsonb_build_object('id',m.id,'position',m.position,'title',m.title,'description',m.description,'objective',m.communication_objective,'status',m.status,'score',m.progress_score,'evidenceLessons',m.evidence_lesson_count,'completedAt',m.completed_at) ORDER BY m.position),'[]') FROM product_gotit.private_lesson_milestones m WHERE m.application_id=r.application_id AND m.application_user_id=r.application_user_id AND m.roadmap_id=r.id) AS milestones FROM product_gotit.private_lesson_roadmaps r WHERE r.application_id=$1 AND r.application_user_id=$2`,
  packs: `SELECT p.pack_id AS id,w.title,p.status,p.installed_version AS version,p.added_at AS "createdAt",p.removed_at AS "removedAt",(SELECT count(*)::int FROM product_gotit.word_pack_entries e WHERE e.pack_id=p.pack_id) AS "wordCount",(SELECT count(*)::int FROM product_gotit.user_word_pack_known_entries k WHERE k.application_id=p.application_id AND k.application_user_id=p.application_user_id AND k.pack_id=p.pack_id) AS "knownWords" FROM product_gotit.user_word_packs p JOIN product_gotit.word_packs w ON w.id=p.pack_id WHERE p.application_id=$1 AND p.application_user_id=$2`,
  usage: `SELECT id,operation,provider,model,status,input_tokens AS "inputTokens",output_tokens AS "outputTokens",cached_input_tokens AS "cachedInputTokens",created_at AS "createdAt" FROM product_gotit.ai_usage_events WHERE application_id=$1 AND application_user_id=$2`,
  games: `SELECT s.session_type AS id,s.session_type AS game,count(DISTINCT s.id)::int AS sessions,count(a.id)::int AS attempts,count(a.id) FILTER (WHERE a.result='correct')::int AS "correctAttempts",avg(a.score)::float8 AS "averageScore",max(a.created_at) AS "lastPlayedAt" FROM product_gotit.practice_sessions s LEFT JOIN product_gotit.practice_attempts a ON a.application_id=s.application_id AND a.application_user_id=s.application_user_id AND a.practice_session_id=s.id WHERE s.application_id=$1 AND s.application_user_id=$2 GROUP BY s.session_type`,
};

export async function learnerOverview(
  tx: DatabaseTransaction,
  repository: ProfileRepository,
  scope: ProfileScope,
) {
  const values = [scope.applicationId, scope.applicationUserId];
  const profileRow = (
    await tx.query(
      `SELECT updated_at::text AS revision,created_at AS "createdAt" FROM product_gotit.user_profiles WHERE application_id=$1 AND application_user_id=$2`,
      values,
    )
  ).rows[0];
  const profile = profileRow ? await repository.loadProfile(tx, scope) : null;
  const activity = (
    await tx.query(
      `SELECT count(*)::int AS "activeDays",min(date) AS "firstActivityDay",max(date) AS "lastActivityDay",COALESCE(sum("practiceSeconds"),0)::float8 AS "practiceSeconds",COALESCE(sum("lessonSeconds"),0)::float8 AS "lessonSeconds",COALESCE(sum("measuredSeconds"),0)::float8 AS "measuredSeconds" FROM (${daily}) d`,
      values,
    )
  ).rows[0];
  const gamification = (
    await tx.query(
      `SELECT total_xp::float8 AS "totalXp",current_level AS level,current_streak_days AS "currentStreakDays",longest_streak_days AS "longestStreakDays" FROM product_gotit.user_gamification WHERE application_id=$1 AND application_user_id=$2`,
      values,
    )
  ).rows[0] ?? { totalXp: 0, level: 1, currentStreakDays: 0, longestStreakDays: 0 };
  const tokens = (
    await tx.query(
      `SELECT count(*)::int AS events,count(*) FILTER (WHERE input_tokens IS NULL OR output_tokens IS NULL)::int AS "unmeasuredEvents",sum(input_tokens)::float8 AS "inputTokens",sum(output_tokens)::float8 AS "outputTokens",sum(cached_input_tokens)::float8 AS "cachedInputTokens",(sum(input_tokens)+sum(output_tokens))::float8 AS "measuredTotalTokens",min(created_at) FILTER (WHERE input_tokens IS NOT NULL OR output_tokens IS NOT NULL) AS "firstMeasuredEventAt" FROM product_gotit.ai_usage_events WHERE application_id=$1 AND application_user_id=$2`,
      values,
    )
  ).rows[0];
  const learning = (
    await tx.query(
      `SELECT count(*)::int AS items,count(*) FILTER (WHERE learning_status='mastered')::int AS mastered,count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted FROM product_gotit.learning_items WHERE application_id=$1 AND application_user_id=$2`,
      values,
    )
  ).rows[0];
  const practice = (
    await tx.query(
      `SELECT count(*)::int AS sessions,count(*) FILTER (WHERE status='completed')::int AS completed FROM product_gotit.practice_sessions WHERE application_id=$1 AND application_user_id=$2`,
      values,
    )
  ).rows[0];
  const scores = (
    await tx.query(
      `SELECT count(*)::int AS attempts,avg(score)::float8 AS "averageScore" FROM product_gotit.practice_attempts WHERE application_id=$1 AND application_user_id=$2`,
      values,
    )
  ).rows[0];
  const lessons = (
    await tx.query(
      `SELECT count(*)::int AS total,count(*) FILTER (WHERE status='completed')::int AS completed,count(*) FILTER (WHERE actual_duration_seconds IS NULL)::int AS "unmeasuredDurations" FROM product_gotit.private_lesson_sessions WHERE application_id=$1 AND application_user_id=$2`,
      values,
    )
  ).rows[0];
  const notifications =
    (
      await tx.query(
        `SELECT updated_at::text AS revision,practice_email AS "practiceEmail",practice_push AS "practicePush",system_email AS "systemEmail",system_push AS "systemPush",reminder_hour AS "reminderHour",verified_email AS "deliveryEmail" FROM product_gotit.notification_preferences WHERE application_id=$1 AND application_user_id=$2`,
        values,
      )
    ).rows[0] ?? null;
  const lessonPreferences = (
    await tx.query(
      `SELECT updated_at::text AS revision,target_language_code AS "targetLanguageCode",support_language_code AS "supportLanguageCode",requested_duration_minutes AS "requestedDurationMinutes",teacher_voice AS "teacherVoice",speech_rate AS "speechRate",correction_mode AS "correctionMode",vocabulary_mode AS "vocabularyMode",focus_areas AS "focusAreas",custom_focus AS "customFocus",lesson_mode AS "lessonMode",teaching_language AS "teachingLanguage" FROM product_gotit.private_lesson_preferences WHERE application_id=$1 AND application_user_id=$2 ORDER BY target_language_code`,
      values,
    )
  ).rows;
  return {
    data: {
      id: scope.applicationUserId,
      revision: profileRow?.revision ?? null,
      productCreatedAt: profileRow?.createdAt ?? null,
      profile,
      activity,
      gamification,
      tokens,
      learning,
      practice,
      scores,
      lessons,
      notifications,
      lessonPreferences,
      coverage: {
        time: 'Recorded active practice seconds plus recorded private-lesson duration; excludes browsing, idle time and unmeasured lessons. Lessons are attributed to their start day.',
        days: 'Days with recorded practice, lessons, vocabulary or course/homework creation; excludes untracked visits.',
        tokens:
          'Measured provider events only. Historical/streaming usage and monetary cost may be unknown. Cached tokens are a subset of input tokens.',
      },
    },
  };
}

export async function learnerHistory(
  tx: DatabaseTransaction,
  scope: ProfileScope,
  section: Exclude<z.infer<typeof learnerSectionSchema>, 'overview'>,
  query: z.infer<typeof learnerPageSchema>,
  courseId?: string,
) {
  const values: unknown[] = [scope.applicationId, scope.applicationUserId];
  let source: string = sources[section];
  if (courseId) {
    values.push(courseId);
    source = `SELECT * FROM (${source}) c WHERE c.id=$3`;
  }
  const total = (await tx.query(`SELECT count(*)::int AS total FROM (${source}) r`, values))
    .rows[0]!.total;
  const sort =
    section === 'activity'
      ? 'date'
      : section === 'games'
        ? 'lastPlayedAt'
        : ['sessions', 'lessons'].includes(section)
          ? 'startedAt'
          : 'createdAt';
  const rows = (
    await tx.query(
      `SELECT * FROM (${source}) r ORDER BY "${sort}" DESC NULLS LAST,id DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, query.perPage, (query.page - 1) * query.perPage],
    )
  ).rows;
  for (const row of rows) {
    if (section === 'courses') {
      const course = publicCourse(row.document as CourseDocument);
      const active = course.versions.find((v) => v.version === course.activeVersion);
      const draft = course.versions.find((v) => v.version === course.draftVersion);
      Object.assign(row, {
        title: active?.plan.title ?? draft?.plan.title ?? course.preferences.goal,
        status: active ? (course.nextLesson ? 'active' : 'completed') : draft ? 'draft' : 'intake',
        preferences: course.preferences,
        activeVersion: course.activeVersion,
        draftVersion: course.draftVersion,
        plan: active?.plan ?? null,
        draftPlan: draft?.plan ?? null,
        evidence: course.evidence,
        progress: course.progress,
        nextLesson: course.nextLesson,
        assignmentId: `${scope.applicationUserId}_${row.id}`,
      });
      delete row.document;
      if (!courseId)
        for (const key of ['preferences', 'plan', 'draftPlan', 'evidence']) delete row[key];
    }
    if (section === 'homework') {
      Object.assign(row, homeworkSummary(row.document as HomeworkDocument));
      delete row.document;
    }
  }
  return { data: rows, total };
}

export async function updateLearnerProfile(
  tx: DatabaseTransaction,
  repository: ProfileRepository,
  scope: ProfileScope,
  input: z.infer<typeof learnerProfileSchema>,
) {
  const row = (
    await tx.query(
      `SELECT updated_at::text AS revision FROM product_gotit.user_profiles WHERE application_id=$1 AND application_user_id=$2 FOR UPDATE`,
      [scope.applicationId, scope.applicationUserId],
    )
  ).rows[0];
  if (!row || row.revision !== input.expectedRevision)
    throw new AppError(409, 'CONFLICT', 'Profile changed. Reload before saving.');
  const profile = await repository.patch(
    scope,
    PROFILE_DEFAULTS,
    normalizePatch(input.changes),
    tx,
  );
  const revision = (
    await tx.query(
      `SELECT updated_at::text AS revision FROM product_gotit.user_profiles WHERE application_id=$1 AND application_user_id=$2`,
      [scope.applicationId, scope.applicationUserId],
    )
  ).rows[0]!.revision;
  return {
    id: scope.applicationUserId,
    applicationUserId: scope.applicationUserId,
    profile,
    revision,
  };
}

export async function updateLearnerSettings(
  tx: DatabaseTransaction,
  scope: ProfileScope,
  input: z.infer<typeof learnerSettingsSchema>,
  user: { email?: string; emailVerified?: boolean },
) {
  const values = [scope.applicationId, scope.applicationUserId];
  // Existing preference rows participate in the same lock/CAS protocol as learner writes.
  const table =
    input.kind === 'notifications' ? 'notification_preferences' : 'private_lesson_preferences';
  const language =
    input.kind === 'lesson'
      ? Intl.getCanonicalLocales(input.changes.targetLanguageCode)[0]!.split('-')[0]!.toLowerCase()
      : null;
  const old = (
    await tx.query(
      `SELECT updated_at::text AS revision FROM product_gotit.${table} WHERE application_id=$1 AND application_user_id=$2 ${language ? 'AND target_language_code=$3' : ''} FOR UPDATE`,
      [...values, ...(language ? [language] : [])],
    )
  ).rows[0];
  if ((old?.revision ?? null) !== input.expectedRevision)
    throw new AppError(409, 'CONFLICT', 'Settings changed. Reload before saving.');
  let result;
  if (input.kind === 'notifications') {
    const c = input.changes;
    if ((c.practiceEmail || c.systemEmail) && (!user.emailVerified || !user.email))
      throw new AppError(409, 'VERIFIED_EMAIL_REQUIRED', 'The target email must be verified');
    result = await tx.query(
      `INSERT INTO product_gotit.notification_preferences(application_id,application_user_id,practice_email,practice_push,system_email,system_push,reminder_hour,verified_email) VALUES($1,$2,COALESCE($3,false),COALESCE($4,false),COALESCE($5,false),COALESCE($6,false),COALESCE($7,18),$8) ON CONFLICT(application_id,application_user_id) DO UPDATE SET practice_email=COALESCE($3,notification_preferences.practice_email),practice_push=COALESCE($4,notification_preferences.practice_push),system_email=COALESCE($5,notification_preferences.system_email),system_push=COALESCE($6,notification_preferences.system_push),reminder_hour=COALESCE($7,notification_preferences.reminder_hour),verified_email=$8,updated_at=now() WHERE notification_preferences.updated_at::text=$9 RETURNING updated_at::text AS revision`,
      [
        ...values,
        c.practiceEmail ?? null,
        c.practicePush ?? null,
        c.systemEmail ?? null,
        c.systemPush ?? null,
        c.reminderHour ?? null,
        user.emailVerified ? user.email : null,
        input.expectedRevision,
      ],
    );
  } else {
    const c = input.changes;
    result = await tx.query(
      `INSERT INTO product_gotit.private_lesson_preferences(application_id,application_user_id,target_language_code,support_language_code,lesson_mode,teaching_language,requested_duration_minutes,teacher_voice,speech_rate,correction_mode,vocabulary_mode,focus_areas,custom_focus) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) ON CONFLICT(application_id,application_user_id,target_language_code) DO UPDATE SET support_language_code=EXCLUDED.support_language_code,lesson_mode=EXCLUDED.lesson_mode,teaching_language=EXCLUDED.teaching_language,requested_duration_minutes=EXCLUDED.requested_duration_minutes,teacher_voice=EXCLUDED.teacher_voice,speech_rate=EXCLUDED.speech_rate,correction_mode=EXCLUDED.correction_mode,vocabulary_mode=EXCLUDED.vocabulary_mode,focus_areas=EXCLUDED.focus_areas,custom_focus=EXCLUDED.custom_focus,updated_at=now() WHERE private_lesson_preferences.updated_at::text=$14 RETURNING updated_at::text AS revision`,
      [
        ...values,
        language,
        c.supportLanguageCode,
        c.lessonMode,
        c.teachingLanguage ?? (c.lessonMode === 'absolute_beginner' ? 'support' : 'target'),
        c.requestedDurationMinutes,
        c.teacherVoice,
        c.speechRate,
        c.correctionMode,
        c.vocabularyMode,
        JSON.stringify(c.focusAreas),
        c.customFocus,
        input.expectedRevision,
      ],
    );
  }
  if (!result.rows[0])
    throw new AppError(409, 'CONFLICT', 'Settings changed. Reload before saving.');
  return {
    id: scope.applicationUserId,
    applicationUserId: scope.applicationUserId,
    revision: result.rows[0].revision,
  };
}
