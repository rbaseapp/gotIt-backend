import type { Pool } from 'pg';
import { AppError } from '../../shared/errors/app-error.js';
import type { ProfileScope } from '../profile/profile.types.js';

export type AddonKind = 'ai' | 'private_lessons';
export type AddonStatus = {
  cycleId: string;
  packageKey: string;
  startsAt: string;
  endsAt: string;
  lessonLimit: number | null;
  lessonDurationSeconds: number | null;
  lessonsUsed: number;
  lessonsRemaining: number | null;
};

export interface AddonAccessContract {
  status(scope: ProfileScope, kind: AddonKind): Promise<AddonStatus | null>;
  reserveLesson(scope: ProfileScope, lessonId: string): Promise<AddonStatus>;
  releaseLesson(lessonId: string): Promise<void>;
}

type CycleRow = {
  id: string;
  package_key: string;
  starts_at: Date;
  ends_at: Date;
  lesson_limit: number | null;
  lesson_duration_seconds: number | null;
  lessons_used: number;
};

const currentCycle = `application_id=$1 AND application_user_id=$2 AND kind=$3
  AND revoked_at IS NULL AND starts_at<=statement_timestamp() AND ends_at>statement_timestamp()
  AND EXISTS (SELECT 1 FROM product_gotit.addon_packages p WHERE p.key=package_key AND p.active)`;

function publicStatus(row: CycleRow): AddonStatus {
  return {
    cycleId: row.id,
    packageKey: row.package_key,
    startsAt: row.starts_at.toISOString(),
    endsAt: row.ends_at.toISOString(),
    lessonLimit: row.lesson_limit,
    lessonDurationSeconds: row.lesson_duration_seconds,
    lessonsUsed: row.lessons_used,
    lessonsRemaining: row.lesson_limit === null ? null : row.lesson_limit - row.lessons_used,
  };
}

export class PostgresAddonAccess implements AddonAccessContract {
  constructor(private readonly pool: Pool) {}

  async status(scope: ProfileScope, kind: AddonKind): Promise<AddonStatus | null> {
    const result = await this.pool.query<CycleRow>(
      `SELECT id,package_key,starts_at,ends_at,lesson_limit,lesson_duration_seconds,lessons_used
       FROM product_gotit.addon_cycles WHERE ${currentCycle}`,
      [scope.applicationId, scope.applicationUserId, kind],
    );
    return result.rows[0] ? publicStatus(result.rows[0]) : null;
  }

  async reserveLesson(scope: ProfileScope, lessonId: string): Promise<AddonStatus> {
    const result = await this.pool.query<CycleRow>(
      `WITH updated AS (
         UPDATE product_gotit.addon_cycles SET lessons_used=lessons_used+1
         WHERE ${currentCycle} AND lessons_used<lesson_limit
         RETURNING id,package_key,starts_at,ends_at,lesson_limit,lesson_duration_seconds,lessons_used
       ), reserved AS (
         INSERT INTO product_gotit.addon_lesson_reservations(lesson_id,cycle_id)
         SELECT $4,id FROM updated RETURNING cycle_id
       ) SELECT updated.* FROM updated JOIN reserved ON reserved.cycle_id=updated.id`,
      [scope.applicationId, scope.applicationUserId, 'private_lessons', lessonId],
    );
    if (result.rows[0]) return publicStatus(result.rows[0]);
    const status = await this.status(scope, 'private_lessons');
    if (!status) throw addonRequired('private_lessons');
    throw new AppError(429, 'PRIVATE_LESSON_LIMIT_REACHED', 'The lesson allowance is exhausted', {
      limit: status.lessonLimit,
      used: status.lessonsUsed,
      resetsAt: status.endsAt,
    });
  }

  async releaseLesson(lessonId: string): Promise<void> {
    await this.pool.query(
      `WITH released AS (
         UPDATE product_gotit.addon_lesson_reservations
         SET released_at=statement_timestamp()
         WHERE lesson_id=$1 AND released_at IS NULL RETURNING cycle_id
       ) UPDATE product_gotit.addon_cycles SET lessons_used=lessons_used-1
         WHERE id IN (SELECT cycle_id FROM released)`,
      [lessonId],
    );
  }
}

export function addonRequired(kind: AddonKind) {
  return new AppError(402, 'ADDON_REQUIRED', 'An active add-on is required', { kind });
}
