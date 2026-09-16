import type { Pool } from 'pg';
import { withTransaction } from '../../shared/database/transaction.js';
import type { ProfileScope, ProfileServiceContract } from '../profile/profile.types.js';
import { scopeValues } from '../library/library.repository.js';
import { calendarDay, previousDay, levelForXp } from '../learning/learning.policy.js';

export class DashboardService {
  constructor(
    private readonly pool: Pool,
    private readonly profiles: ProfileServiceContract,
  ) {}
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
        const xp = Number(row?.total_xp ?? 0),
          level = levelForXp(xp);
        return {
          totalXp: xp,
          level,
          nextLevelXp: 100 * level ** 2,
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
  async activity(scope: ProfileScope, days = 30) {
    const profile = await this.profiles.getProfile(scope);
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
  async dashboard(scope: ProfileScope) {
    const profile = await this.profiles.getProfile(scope),
      today = calendarDay(new Date(), profile.timezone);
    const data = await withTransaction(
      this.pool,
      async (tx) => {
        const counts = (
          await tx.query(
            `SELECT count(*)::integer total,count(*) FILTER(WHERE learning_status='new')::integer AS new,count(*) FILTER(WHERE learning_status='learning')::integer learning,count(*) FILTER(WHERE learning_status='reviewing')::integer reviewing,count(*) FILTER(WHERE learning_status='mastered')::integer mastered,
        count(*) FILTER(WHERE user_status='active' AND next_review_at<=now())::integer due,count(*) FILTER(WHERE manual_hard OR system_difficulty>=0.7)::integer difficult,count(*) FILTER(WHERE user_priority='high')::integer AS "highPriority"
        FROM product_gotit.learning_items WHERE application_id=$1 AND application_user_id=$2 AND deleted_at IS NULL`,
            scopeValues(scope),
          )
        ).rows[0];
        const skills = (
          await tx.query(
            `SELECT skill_type AS skill,round(avg(mastery_score),2)::float8 AS "masteryScore",sum(attempt_count)::integer AS "evidenceAttempts" FROM product_gotit.item_skill_progress p JOIN product_gotit.learning_items i ON i.id=p.learning_item_id AND i.application_id=p.application_id AND i.application_user_id=p.application_user_id WHERE p.application_id=$1 AND p.application_user_id=$2 AND i.deleted_at IS NULL GROUP BY skill_type ORDER BY skill_type`,
            scopeValues(scope),
          )
        ).rows;
        const modes = (
          await tx.query(
            `SELECT exercise_type AS "exerciseType",count(*)::integer attempts,round(avg(score),2)::float8 AS "averageScore" FROM product_gotit.practice_attempts WHERE application_id=$1 AND application_user_id=$2 AND result<>'skipped' GROUP BY exercise_type ORDER BY exercise_type`,
            scopeValues(scope),
          )
        ).rows;
        const goal = (
          await tx.query(
            `SELECT COALESCE((SELECT practice_seconds FROM product_gotit.user_daily_activity WHERE application_id=$1 AND application_user_id=$2 AND activity_date=$3),0)::integer seconds,count(*)::integer attempts,count(DISTINCT learning_item_id)::integer items FROM product_gotit.practice_attempts WHERE application_id=$1 AND application_user_id=$2 AND (created_at AT TIME ZONE $4)::date=$3::date AND result<>'skipped'`,
            [...scopeValues(scope), today, profile.timezone],
          )
        ).rows[0]!;
        const recent = (
          await tx.query(
            `SELECT id,learning_item_id AS "learningItemId",exercise_type AS "exerciseType",result,score::float8 AS score,created_at AS "createdAt" FROM product_gotit.practice_attempts WHERE application_id=$1 AND application_user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 10`,
            scopeValues(scope),
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
      weeklyActivity: await this.activity(scope, 7),
    };
  }
}
