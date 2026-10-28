import type { DatabaseTransaction } from '../../shared/database/transaction.js';
import type { ProfileScope } from '../profile/profile.types.js';
import { calendarDay, levelForXp } from '../learning/learning.policy.js';
import { scopeValues } from '../library/library.repository.js';

/** Fixed daily completion bonuses, separate from rate-limited practice XP. */
export const DAILY_TASK_REWARDS = { lesson: 100, conversation: 75, reading: 50 } as const;
export type DailyTask = keyof typeof DAILY_TASK_REWARDS;
export const dailyTaskKey = (day: string, task: DailyTask) => `daily-task:v1:${day}:${task}`;

/** Caller holds the same practice-user lock as ordinary XP awards. */
export async function awardDailyTask(
  tx: DatabaseTransaction,
  scope: ProfileScope,
  task: DailyTask,
  sourceId: string,
  timezone: string,
  now: Date,
) {
  const day = calendarDay(now, timezone),
    amount = DAILY_TASK_REWARDS[task];
  const inserted = await tx.query(
    `INSERT INTO product_gotit.xp_events(application_id,application_user_id,source_type,source_id,xp_amount,reason_code,idempotency_key,created_at)
     VALUES($1,$2,'daily_task',$3,$4,$5,$6,$7)
     ON CONFLICT(application_id,application_user_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`,
    [...scopeValues(scope), sourceId, amount, task, dailyTaskKey(day, task), now],
  );
  if (!inserted.rowCount) return 0;
  const current = (
    await tx.query(
      'SELECT total_xp FROM product_gotit.user_gamification WHERE application_id=$1 AND application_user_id=$2 FOR UPDATE',
      scopeValues(scope),
    )
  ).rows[0];
  const total = Number(current?.total_xp ?? 0) + amount;
  await tx.query(
    `INSERT INTO product_gotit.user_gamification(application_id,application_user_id,total_xp,current_level)
     VALUES($1,$2,$3,$4) ON CONFLICT(application_id,application_user_id) DO UPDATE
     SET total_xp=EXCLUDED.total_xp,current_level=EXCLUDED.current_level,updated_at=now()`,
    [...scopeValues(scope), total, levelForXp(total)],
  );
  await tx.query(
    `INSERT INTO product_gotit.user_daily_activity(application_id,application_user_id,activity_date,xp_earned)
     VALUES($1,$2,$3,$4) ON CONFLICT(application_id,application_user_id,activity_date)
     DO UPDATE SET xp_earned=product_gotit.user_daily_activity.xp_earned+EXCLUDED.xp_earned`,
    [...scopeValues(scope), day, amount],
  );
  return amount;
}
