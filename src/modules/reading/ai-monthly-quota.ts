import type { Pool } from 'pg';
import { AppError } from '../../shared/errors/app-error.js';
import type { ProfileScope } from '../profile/profile.types.js';

export const AI_MONTHLY_LIMIT = 4;

export type AiMonthlyQuotaStatus = {
  limit: number;
  used: number;
  remaining: number;
  resetsAt: string;
};

export interface AiMonthlyQuotaContract {
  status(scope: ProfileScope): Promise<AiMonthlyQuotaStatus>;
  reserve(scope: ProfileScope): Promise<AiMonthlyQuotaStatus>;
  release(scope: ProfileScope): Promise<void>;
}

export class AiMonthlyQuota implements AiMonthlyQuotaContract {
  constructor(private readonly pool: Pool) {}

  async status(scope: ProfileScope): Promise<AiMonthlyQuotaStatus> {
    const result = await this.pool.query<{ generation_count: number }>(
      `SELECT generation_count FROM product_gotit.ai_monthly_usage
       WHERE application_id=$1 AND application_user_id=$2
         AND usage_month=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date`,
      [scope.applicationId, scope.applicationUserId],
    );
    return quotaStatus(result.rows[0]?.generation_count ?? 0);
  }

  async reserve(scope: ProfileScope): Promise<AiMonthlyQuotaStatus> {
    const result = await this.pool.query<{ generation_count: number }>(
      `INSERT INTO product_gotit.ai_monthly_usage(
         application_id,application_user_id,usage_month,generation_count)
       VALUES($1,$2,date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date,1)
       ON CONFLICT(application_id,application_user_id,usage_month) DO UPDATE SET
         generation_count=product_gotit.ai_monthly_usage.generation_count+1,
         updated_at=clock_timestamp()
       WHERE product_gotit.ai_monthly_usage.generation_count<$3
       RETURNING generation_count`,
      [scope.applicationId, scope.applicationUserId, AI_MONTHLY_LIMIT],
    );
    if (!result.rows[0]) {
      const status = await this.status(scope);
      throw new AppError(
        429,
        'AI_MONTHLY_LIMIT_REACHED',
        'The monthly AI reading limit was reached',
        status,
      );
    }
    return quotaStatus(result.rows[0].generation_count);
  }

  async release(scope: ProfileScope): Promise<void> {
    await this.pool.query(
      `WITH changed AS (
         UPDATE product_gotit.ai_monthly_usage
         SET generation_count=GREATEST(0,generation_count-1),updated_at=clock_timestamp()
         WHERE application_id=$1 AND application_user_id=$2
           AND usage_month=date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date
         RETURNING application_id,application_user_id,usage_month,generation_count
       )
       DELETE FROM product_gotit.ai_monthly_usage usage
       USING changed
       WHERE changed.generation_count=0
         AND usage.application_id=changed.application_id
         AND usage.application_user_id=changed.application_user_id
         AND usage.usage_month=changed.usage_month`,
      [scope.applicationId, scope.applicationUserId],
    );
  }
}

function quotaStatus(used: number): AiMonthlyQuotaStatus {
  const now = new Date();
  const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    limit: AI_MONTHLY_LIMIT,
    used,
    remaining: Math.max(0, AI_MONTHLY_LIMIT - used),
    resetsAt: resetsAt.toISOString(),
  };
}
