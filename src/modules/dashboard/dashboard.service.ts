import type { Pool } from 'pg';
import { withTransaction } from '../../shared/database/transaction.js';
import type { ProfileScope, ProfileServiceContract } from '../profile/profile.types.js';
import { scopeValues } from '../library/library.repository.js';
import {
  DEFAULT_LEARNING_POLICY,
  LEARNED_REVIEW_STAGE,
  calendarDay,
  previousDay,
  levelForXp,
  type LearningPolicy,
} from '../learning/learning.policy.js';

export class DashboardService {
  constructor(
    private readonly pool: Pool,
    private readonly profiles: ProfileServiceContract,
    private readonly policy: LearningPolicy = DEFAULT_LEARNING_POLICY,
  ) {}
  async languages(scope: ProfileScope) {
    return withTransaction(
      this.pool,
      async (tx) => ({
        languages: (
          await tx.query(
            `SELECT source_language_code AS "code",count(*)::integer AS count
         FROM product_gotit.learning_items WHERE application_id=$1 AND application_user_id=$2
         GROUP BY source_language_code ORDER BY count DESC,source_language_code`,
            scopeValues(scope),
          )
        ).rows,
      }),
      true,
    );
  }
  async gamification(scope: ProfileScope) {
    const profile = await this.profiles.getProfile(scope),
      today = calendarDay(new Date(), profile.timezone);
    return withTransaction(
      this.pool,
      async (tx) => {
        const row = (
          await tx.query(
            'SELECT total_xp,current_streak_days,longest_streak_days,last_activity_date::text AS activity_day FROM product_gotit.user_gamification WHERE application_id=$1 AND application_user_id=$2',
            scopeValues(scope),
          )
        ).rows[0];
        const todayXp = Number(
          (
            await tx.query(
              'SELECT COALESCE(xp_earned,0)::integer AS xp FROM product_gotit.user_daily_activity WHERE application_id=$1 AND application_user_id=$2 AND activity_date=$3',
              [...scopeValues(scope), today],
            )
          ).rows[0]?.xp ?? 0,
        );
        const xp = Number(row?.total_xp ?? 0),
          level = levelForXp(xp),
          dailyXpRemaining = Math.max(0, this.policy.dailyXpCap - todayXp);
        return {
          totalXp: xp,
          level,
          nextLevelXp: 100 * level ** 2,
          todayXp,
          dailyXpCap: this.policy.dailyXpCap,
          dailyXpRemaining,
          dailyXpCapReached: dailyXpRemaining === 0,
          postDailyCapPercent: this.policy.postDailyCapPercent,
          currentStreakDays: [today, previousDay(today)].includes(row?.activity_day)
            ? (row?.current_streak_days ?? 0)
            : 0,
          longestStreakDays: row?.longest_streak_days ?? 0,
          lastActivityDate: row?.activity_day ?? null,
        };
      },
      true,
    );
  }
  async activity(scope: ProfileScope, days = 30, languageCode?: string) {
    const profile = await this.profiles.getProfile(scope);
    if (languageCode)
      return withTransaction(
        this.pool,
        async (tx) => ({
          timezone: profile.timezone,
          days: (
            await tx.query(
              `SELECT dates.day::date::text AS date,COALESCE(sum(LEAST(a.response_time_ms,120000)),0)::integer/1000 AS "practiceSeconds",0::integer AS "sessionsCompleted",
          count(a.id)::integer AS attempts,
          count(a.id) FILTER(WHERE a.result='correct')::integer AS "correctAttempts",
          count(DISTINCT a.learning_item_id)::integer AS "itemsPracticed",
          count(DISTINCT i.id) FILTER(WHERE (i.first_mastered_at AT TIME ZONE $3)::date=dates.day)::integer AS "itemsMastered",
          COALESCE((SELECT sum(x.xp_amount) FROM product_gotit.xp_events x
              LEFT JOIN product_gotit.practice_attempts earned ON earned.id=x.source_id AND earned.application_id=x.application_id AND earned.application_user_id=x.application_user_id AND x.source_type='attempt'
              JOIN product_gotit.learning_items word ON word.id=COALESCE(earned.learning_item_id,CASE WHEN x.source_type='mastery' THEN x.source_id END) AND word.application_id=$1 AND word.application_user_id=$2
            WHERE x.application_id=$1 AND x.application_user_id=$2 AND word.source_language_code=$5
              AND (x.created_at AT TIME ZONE $3)::date=dates.day::date),0)::integer AS "xpEarned"
         FROM generate_series((now() AT TIME ZONE $3)::date-($4::integer-1),(now() AT TIME ZONE $3)::date,'1 day'::interval) AS dates(day)
         LEFT JOIN product_gotit.practice_attempts a ON a.application_id=$1 AND a.application_user_id=$2
           AND (a.created_at AT TIME ZONE $3)::date=dates.day::date
           AND EXISTS(SELECT 1 FROM product_gotit.learning_items item WHERE item.id=a.learning_item_id
             AND item.application_id=$1 AND item.application_user_id=$2 AND item.source_language_code=$5)
         LEFT JOIN product_gotit.learning_items i ON i.id=a.learning_item_id AND i.application_id=$1 AND i.application_user_id=$2
         GROUP BY dates.day ORDER BY dates.day`,
              [...scopeValues(scope), profile.timezone, days, languageCode],
            )
          ).rows,
        }),
        true,
      );
    return withTransaction(
      this.pool,
      async (tx) => ({
        timezone: profile.timezone,
        days: (
          await tx.query(
            `SELECT activity_date::text AS date,practice_seconds AS "practiceSeconds",sessions_completed AS "sessionsCompleted",attempts,correct_attempts AS "correctAttempts",items_practiced AS "itemsPracticed",items_mastered AS "itemsMastered",xp_earned AS "xpEarned"
      FROM product_gotit.user_daily_activity WHERE application_id=$1 AND application_user_id=$2 AND activity_date>=(now() AT TIME ZONE $3)::date-($4::integer-1) ORDER BY activity_date`,
            [...scopeValues(scope), profile.timezone, days],
          )
        ).rows,
      }),
      true,
    );
  }
  async dashboard(scope: ProfileScope, recentPage = 1, recentLimit = 6, languageCode?: string) {
    const profile = await this.profiles.getProfile(scope),
      today = calendarDay(new Date(), profile.timezone);
    const data = await withTransaction(
      this.pool,
      async (tx) => {
        const counts = (
          await tx.query(
            `SELECT count(*)::integer total,count(*) FILTER(WHERE learning_status='new')::integer AS new,count(*) FILTER(WHERE learning_status='learning')::integer learning,count(*) FILTER(WHERE learning_status='reviewing')::integer reviewing,count(*) FILTER(WHERE learning_status='mastered')::integer mastered,
        count(*) FILTER(WHERE user_status='active' AND next_review_at<=now())::integer due,count(*) FILTER(WHERE manual_hard OR system_difficulty>=0.7)::integer difficult,count(*) FILTER(WHERE user_priority='high')::integer AS "highPriority",
        count(*) FILTER(WHERE user_status='active' AND learning_status<>'mastered'
          AND (SELECT count(*) FROM product_gotit.practice_attempts scored
            WHERE scored.application_id=learning_items.application_id AND scored.application_user_id=learning_items.application_user_id
              AND scored.learning_item_id=learning_items.id AND scored.result<>'skipped'
              AND COALESCE(scored.learning_revision,1)=learning_items.learning_revision)>=$4
          AND (review_stage<${LEARNED_REVIEW_STAGE} OR overall_mastery_score<$7
            OR (SELECT count(*) FROM product_gotit.practice_attempts successful
              WHERE successful.application_id=learning_items.application_id AND successful.application_user_id=learning_items.application_user_id
                AND successful.learning_item_id=learning_items.id AND successful.result<>'skipped' AND successful.score>=85
                AND successful.user_answer_text IS NOT NULL AND COALESCE(successful.learning_revision,1)=learning_items.learning_revision
                AND EXISTS(SELECT 1 FROM product_gotit.attempt_skill_effects effect
                  WHERE effect.practice_attempt_id=successful.id AND effect.skill_type='recall'))<$5
            OR (SELECT count(DISTINCT (successful.created_at AT TIME ZONE $3)::date)
              FROM product_gotit.practice_attempts successful
              WHERE successful.application_id=learning_items.application_id AND successful.application_user_id=learning_items.application_user_id
                AND successful.learning_item_id=learning_items.id AND successful.result<>'skipped' AND successful.score>=85
                AND successful.user_answer_text IS NOT NULL AND COALESCE(successful.learning_revision,1)=learning_items.learning_revision
                AND EXISTS(SELECT 1 FROM product_gotit.attempt_skill_effects effect
                  WHERE effect.practice_attempt_id=successful.id AND effect.skill_type='recall'))<$6))::integer AS "awaitingRecall"
        FROM product_gotit.learning_items WHERE application_id=$1 AND application_user_id=$2
          AND user_status='active' AND deleted_at IS NULL
          AND ($8::text IS NULL OR source_language_code=$8)`,
            [
              ...scopeValues(scope),
              profile.timezone,
              this.policy.minimumScoredAttempts,
              this.policy.minimumActiveRecallSuccesses,
              this.policy.minimumActiveRecallCalendarDays,
              this.policy.masteryThreshold,
              languageCode ?? null,
            ],
          )
        ).rows[0];
        const skills = (
          await tx.query(
            `SELECT skill_type AS skill,round(avg(mastery_score),2)::float8 AS "masteryScore",sum(attempt_count)::integer AS "evidenceAttempts" FROM product_gotit.item_skill_progress p JOIN product_gotit.learning_items i ON i.id=p.learning_item_id AND i.application_id=p.application_id AND i.application_user_id=p.application_user_id WHERE p.application_id=$1 AND p.application_user_id=$2 AND i.user_status='active' AND i.deleted_at IS NULL AND ($3::text IS NULL OR i.source_language_code=$3) GROUP BY skill_type ORDER BY skill_type`,
            [...scopeValues(scope), languageCode ?? null],
          )
        ).rows;
        const modes = (
          await tx.query(
            `SELECT a.exercise_type AS "exerciseType",count(*)::integer attempts,round(avg(a.score),2)::float8 AS "averageScore" FROM product_gotit.practice_attempts a JOIN product_gotit.learning_items i ON i.id=a.learning_item_id AND i.application_id=a.application_id AND i.application_user_id=a.application_user_id WHERE a.application_id=$1 AND a.application_user_id=$2 AND a.result<>'skipped' AND ($3::text IS NULL OR i.source_language_code=$3) GROUP BY a.exercise_type ORDER BY a.exercise_type`,
            [...scopeValues(scope), languageCode ?? null],
          )
        ).rows;
        const goal = (
          await tx.query(
            `SELECT COALESCE((SELECT practice_seconds FROM product_gotit.user_daily_activity WHERE application_id=$1 AND application_user_id=$2 AND activity_date=$3),0)::integer seconds,count(*)::integer attempts,count(DISTINCT a.learning_item_id)::integer items FROM product_gotit.practice_attempts a JOIN product_gotit.learning_items i ON i.id=a.learning_item_id AND i.application_id=a.application_id AND i.application_user_id=a.application_user_id WHERE a.application_id=$1 AND a.application_user_id=$2 AND (a.created_at AT TIME ZONE $4)::date=$3::date AND a.result<>'skipped' AND ($5::text IS NULL OR i.source_language_code=$5)`,
            [...scopeValues(scope), today, profile.timezone, languageCode ?? null],
          )
        ).rows[0]!;
        const recentTotal = Number(
          (
            await tx.query(
              `SELECT count(*)::integer AS count FROM product_gotit.practice_attempts a JOIN product_gotit.learning_items i ON i.id=a.learning_item_id AND i.application_id=a.application_id AND i.application_user_id=a.application_user_id
               WHERE a.application_id=$1 AND a.application_user_id=$2 AND ($3::text IS NULL OR i.source_language_code=$3)`,
              [...scopeValues(scope), languageCode ?? null],
            )
          ).rows[0]?.count ?? 0,
        );
        const recent = (
          await tx.query(
            `SELECT attempt.id,attempt.learning_item_id AS "learningItemId",
              attempt.exercise_type AS "exerciseType",attempt.result,attempt.score::float8 AS score,
              attempt.created_at AS "createdAt",item.source_text AS "sourceText",
              (SELECT translation_text FROM product_gotit.item_translations translation
               WHERE translation.application_id=item.application_id
                 AND translation.application_user_id=item.application_user_id
                 AND translation.learning_item_id=item.id AND translation.is_current AND translation.is_primary
               ORDER BY translation.id LIMIT 1) AS "primaryTranslation"
             FROM product_gotit.practice_attempts attempt
             JOIN product_gotit.learning_items item ON item.application_id=attempt.application_id
               AND item.application_user_id=attempt.application_user_id AND item.id=attempt.learning_item_id
             WHERE attempt.application_id=$1 AND attempt.application_user_id=$2
               AND ($5::text IS NULL OR item.source_language_code=$5)
             ORDER BY attempt.created_at DESC,attempt.id DESC LIMIT $3 OFFSET $4`,
            [
              ...scopeValues(scope),
              recentLimit,
              (recentPage - 1) * recentLimit,
              languageCode ?? null,
            ],
          )
        ).rows;
        const value =
          profile.dailyGoal.type === 'minutes'
            ? Math.floor(goal.seconds / 60)
            : profile.dailyGoal.type === 'items'
              ? goal.items
              : goal.attempts;
        return {
          counts,
          skills,
          modes,
          recentActivity: recent,
          recentActivityPagination: {
            page: recentPage,
            pageCount: Math.max(1, Math.ceil(recentTotal / recentLimit)),
            totalCount: recentTotal,
            pageSize: recentLimit,
          },
          dailyGoal: {
            ...profile.dailyGoal,
            current: value,
            completed: value >= profile.dailyGoal.value,
            date: today,
          },
        };
      },
      true,
    );
    return {
      ...data,
      gamification: await this.gamification(scope),
      weeklyActivity: await this.activity(scope, 7, languageCode),
    };
  }
}
