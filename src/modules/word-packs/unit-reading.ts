import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { ProfileScope } from '../profile/profile.types.js';
import { unitStepSchema } from './unit-path-choices.js';

export const unitReadingSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9-]{1,60}$/),
    title: z.string().trim().min(1).max(200),
    passage: z.string().trim().min(1).max(12000),
    after: unitStepSchema,
    estimatedMinutes: z.number().int().min(1).max(30),
    questions: z.array(z.string().trim().min(1).max(500)).max(8),
  })
  .strict();
export type UnitReading = z.infer<typeof unitReadingSchema>;
export const readingHash = (reading: UnitReading) =>
  createHash('sha256')
    .update(JSON.stringify(unitReadingSchema.parse(reading)))
    .digest('hex');
export class UnitReadingRepository {
  constructor(private readonly db: Pool) {}
  async completed(scope: ProfileScope, packId: string) {
    return (
      await this.db.query(
        `SELECT reading_id AS id,content_hash AS hash FROM product_gotit.unit_reading_progress WHERE application_id=$1 AND application_user_id=$2 AND pack_id=$3`,
        [scope.applicationId, scope.applicationUserId, packId],
      )
    ).rows as { id: string; hash: string }[];
  }
  async complete(scope: ProfileScope, packId: string, reading: UnitReading) {
    await this.db.query(
      `INSERT INTO product_gotit.unit_reading_progress(application_id,application_user_id,pack_id,reading_id,content_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [scope.applicationId, scope.applicationUserId, packId, reading.id, readingHash(reading)],
    );
  }
}
