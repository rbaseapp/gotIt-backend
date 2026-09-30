import type { Pool, PoolClient } from 'pg';
import { AppError } from '../../shared/errors/app-error.js';
import type { ProfileScope } from '../profile/profile.types.js';
import type { CoreAuthClient, CoreMinuteGrants } from '../../shared/core/core-auth.client.js';

type Grant = { id: string; seconds_total: number; seconds_used: number; ends_at: Date };

export type MinuteBalance = {
  secondsTotal: number;
  secondsUsed: number;
  secondsRemaining: number;
  expiresAt: string | null;
};

export interface MinuteWallet {
  balance(scope: ProfileScope, accessToken: string): Promise<MinuteBalance>;
  reserve(
    scope: ProfileScope,
    lessonId: string,
    seconds: number,
    accessToken: string,
  ): Promise<void>;
  release(lessonId: string): Promise<void>;
}

async function inTransaction<T>(pool: Pool, action: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const result = await action(db);
    await db.query('COMMIT');
    return result;
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  } finally {
    db.release();
  }
}

export class PostgresMinuteWallet implements MinuteWallet {
  constructor(
    private readonly pool: Pool,
    private readonly core: Pick<CoreAuthClient, 'getMinuteGrants'>,
  ) {}

  private async sync(
    db: PoolClient,
    scope: ProfileScope,
    sources: CoreMinuteGrants['grants'],
  ): Promise<Grant[]> {
    const activeIds: string[] = [];
    for (const source of sources) {
      const result = await db.query<{ id: string }>(
        `INSERT INTO product_gotit.private_lesson_minute_grants
           (application_id,application_user_id,source_kind,source_id,starts_at,ends_at,seconds_total)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(source_kind,source_id,starts_at) DO UPDATE SET
           revoked_at=NULL,ends_at=EXCLUDED.ends_at,
           seconds_total=GREATEST(product_gotit.private_lesson_minute_grants.seconds_used,EXCLUDED.seconds_total)
         RETURNING id`,
        [
          scope.applicationId,
          scope.applicationUserId,
          source.sourceKind,
          source.sourceId,
          source.startsAt,
          source.endsAt,
          source.secondsTotal,
        ],
      );
      activeIds.push(result.rows[0]!.id);
    }
    await db.query(
      `UPDATE product_gotit.private_lesson_minute_grants SET revoked_at=statement_timestamp()
       WHERE application_id=$1 AND application_user_id=$2 AND revoked_at IS NULL
         AND ends_at>statement_timestamp() AND NOT (id=ANY($3::uuid[]))`,
      [scope.applicationId, scope.applicationUserId, activeIds],
    );
    return (
      await db.query<Grant>(
        `SELECT id,seconds_total,seconds_used,ends_at
       FROM product_gotit.private_lesson_minute_grants
       WHERE application_id=$1 AND application_user_id=$2 AND revoked_at IS NULL
         AND starts_at<=statement_timestamp() AND ends_at>statement_timestamp()
       ORDER BY ends_at,id FOR UPDATE`,
        [scope.applicationId, scope.applicationUserId],
      )
    ).rows;
  }

  private async locked<T>(
    scope: ProfileScope,
    accessToken: string,
    action: (db: PoolClient, grants: Grant[]) => Promise<T>,
  ): Promise<T> {
    const sources = (await this.core.getMinuteGrants(accessToken)).grants;
    return inTransaction(this.pool, async (db) => {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `minute-wallet:${scope.applicationId}:${scope.applicationUserId}`,
      ]);
      return action(db, await this.sync(db, scope, sources));
    });
  }

  async balance(scope: ProfileScope, accessToken: string): Promise<MinuteBalance> {
    return this.locked(scope, accessToken, async (_db, grants) => ({
      secondsTotal: grants.reduce((sum, grant) => sum + grant.seconds_total, 0),
      secondsUsed: grants.reduce((sum, grant) => sum + grant.seconds_used, 0),
      secondsRemaining: grants.reduce(
        (sum, grant) => sum + grant.seconds_total - grant.seconds_used,
        0,
      ),
      expiresAt: grants[0]?.ends_at.toISOString() ?? null,
    }));
  }

  async reserve(
    scope: ProfileScope,
    lessonId: string,
    seconds: number,
    accessToken: string,
  ): Promise<void> {
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 1800)
      throw new AppError(400, 'PRIVATE_LESSON_DURATION_INVALID', 'Invalid lesson duration');
    await this.locked(scope, accessToken, async (db, grants) => {
      if (
        (
          await db.query(
            'SELECT 1 FROM product_gotit.private_lesson_minute_reservations WHERE lesson_id=$1 LIMIT 1',
            [lessonId],
          )
        ).rowCount
      )
        return;
      const available = grants.reduce(
        (sum, grant) => sum + grant.seconds_total - grant.seconds_used,
        0,
      );
      if (available < seconds)
        throw new AppError(
          402,
          'PRIVATE_LESSON_MINUTES_REQUIRED',
          'Not enough private lesson minutes',
          { secondsAvailable: available, secondsRequested: seconds },
        );
      let remaining = seconds;
      for (const grant of grants) {
        const taken = Math.min(remaining, grant.seconds_total - grant.seconds_used);
        if (!taken) continue;
        await db.query(
          'UPDATE product_gotit.private_lesson_minute_grants SET seconds_used=seconds_used+$2 WHERE id=$1',
          [grant.id, taken],
        );
        await db.query(
          `INSERT INTO product_gotit.private_lesson_minute_reservations(lesson_id,grant_id,seconds_reserved)
          VALUES($1,$2,$3)`,
          [lessonId, grant.id, taken],
        );
        remaining -= taken;
        if (!remaining) break;
      }
    });
  }

  async release(lessonId: string): Promise<void> {
    await inTransaction(this.pool, async (db) => {
      const rows = (
        await db.query<{ grant_id: string; seconds_reserved: number }>(
          `UPDATE product_gotit.private_lesson_minute_reservations SET released_at=statement_timestamp()
         WHERE lesson_id=$1 AND released_at IS NULL
         RETURNING grant_id,seconds_reserved`,
          [lessonId],
        )
      ).rows;
      for (const row of rows)
        await db.query(
          `UPDATE product_gotit.private_lesson_minute_grants SET seconds_used=seconds_used-$2 WHERE id=$1`,
          [row.grant_id, row.seconds_reserved],
        );
    });
  }
}
