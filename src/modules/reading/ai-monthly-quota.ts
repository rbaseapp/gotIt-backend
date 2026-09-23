import type { Pool } from 'pg';
import { AppError } from '../../shared/errors/app-error.js';
import type { ProfileScope } from '../profile/profile.types.js';

export const AI_MONTHLY_PAID_LIMIT = 4;
export const AI_TRIAL_LIMIT = 1;

export type AiQuotaPolicy = {
  limit: number;
  period: 'trial' | 'month';
};

const PAID_QUOTA_POLICY: AiQuotaPolicy = { limit: AI_MONTHLY_PAID_LIMIT, period: 'month' };

export function aiQuotaPolicyForTier(tier: 'free' | 'trial' | 'paid' | undefined): AiQuotaPolicy {
  return tier === 'trial' ? { limit: AI_TRIAL_LIMIT, period: 'trial' } : PAID_QUOTA_POLICY;
}

export type AiMonthlyQuotaStatus = {
  limit: number;
  used: number;
  remaining: number;
  period: AiQuotaPolicy['period'];
  resetsAt: string | null;
};

export interface AiMonthlyQuotaContract {
  status(scope: ProfileScope, policy?: AiQuotaPolicy): Promise<AiMonthlyQuotaStatus>;
  reserve(scope: ProfileScope, policy?: AiQuotaPolicy): Promise<AiMonthlyQuotaStatus>;
  release(scope: ProfileScope, policy?: AiQuotaPolicy): Promise<void>;
}

export class AiMonthlyQuota implements AiMonthlyQuotaContract {
  constructor(private readonly pool: Pool) {}

  async status(
    scope: ProfileScope,
    policy: AiQuotaPolicy = PAID_QUOTA_POLICY,
  ): Promise<AiMonthlyQuotaStatus> {
    const result = await this.pool.query<{ generation_count: number }>(
      `SELECT generation_count FROM product_gotit.ai_monthly_usage
       WHERE application_id=$1 AND application_user_id=$2
         AND usage_month=CASE WHEN $3='trial' THEN DATE '1970-01-01'
           ELSE date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date END`,
      [scope.applicationId, scope.applicationUserId, policy.period],
    );
    return quotaStatus(result.rows[0]?.generation_count ?? 0, policy);
  }

  async reserve(
    scope: ProfileScope,
    policy: AiQuotaPolicy = PAID_QUOTA_POLICY,
  ): Promise<AiMonthlyQuotaStatus> {
    const result = await this.pool.query<{ generation_count: number }>(
      `INSERT INTO product_gotit.ai_monthly_usage(
         application_id,application_user_id,usage_month,generation_count)
       VALUES($1,$2,CASE WHEN $3='trial' THEN DATE '1970-01-01'
         ELSE date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date END,1)
       ON CONFLICT(application_id,application_user_id,usage_month) DO UPDATE SET
         generation_count=product_gotit.ai_monthly_usage.generation_count+1,
         updated_at=clock_timestamp()
       WHERE product_gotit.ai_monthly_usage.generation_count<$4
       RETURNING generation_count`,
      [scope.applicationId, scope.applicationUserId, policy.period, policy.limit],
    );
    if (!result.rows[0]) {
      const status = await this.status(scope, policy);
      throw new AppError(
        429,
        'AI_MONTHLY_LIMIT_REACHED',
        'The AI reading limit was reached',
        status,
      );
    }
    return quotaStatus(result.rows[0].generation_count, policy);
  }

  async release(scope: ProfileScope, policy: AiQuotaPolicy = PAID_QUOTA_POLICY): Promise<void> {
    await this.pool.query(
      `WITH changed AS (
         UPDATE product_gotit.ai_monthly_usage
         SET generation_count=GREATEST(0,generation_count-1),updated_at=clock_timestamp()
         WHERE application_id=$1 AND application_user_id=$2
           AND usage_month=CASE WHEN $3='trial' THEN DATE '1970-01-01'
             ELSE date_trunc('month',clock_timestamp() AT TIME ZONE 'UTC')::date END
         RETURNING application_id,application_user_id,usage_month,generation_count
       )
       DELETE FROM product_gotit.ai_monthly_usage usage
       USING changed
       WHERE changed.generation_count=0
         AND usage.application_id=changed.application_id
         AND usage.application_user_id=changed.application_user_id
         AND usage.usage_month=changed.usage_month`,
      [scope.applicationId, scope.applicationUserId, policy.period],
    );
  }
}

function quotaStatus(used: number, policy: AiQuotaPolicy): AiMonthlyQuotaStatus {
  const now = new Date();
  const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return {
    limit: policy.limit,
    used,
    remaining: Math.max(0, policy.limit - used),
    period: policy.period,
    resetsAt: policy.period === 'month' ? resetsAt.toISOString() : null,
  };
}
