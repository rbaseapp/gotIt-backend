import { z } from 'zod';
import { lessonMaterialSchema } from '../courses/lesson-material.schema.js';
import type { DatabaseTransaction } from '../../shared/database/transaction.js';
import type { ProfileScope } from '../profile/profile.types.js';

export const unitContentSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    entries: z
      .array(
        z
          .object({
            id: z.uuid(),
            sourceText: z.string().trim().min(1).max(200),
            expectedUpdatedAt: z.iso.datetime().optional(),
            translationText: z.string().trim().min(1).max(500),
            exampleText: z.string().max(1000).nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    materials: z
      .object({
        supported: lessonMaterialSchema.optional(),
        midpoint: lessonMaterialSchema.optional(),
        review: lessonMaterialSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type UnitContent = z.infer<typeof unitContentSchema>;
export async function unitOverride(
  tx: Pick<DatabaseTransaction, 'query'>,
  scope: ProfileScope,
  packId: string,
) {
  const row = (
    await tx.query(
      `SELECT content FROM product_gotit.admin_unit_content
    WHERE application_id=$1 AND pack_id=$2 AND (application_user_id=$3 OR application_user_id IS NULL)
    ORDER BY application_user_id NULLS LAST LIMIT 1`,
      [scope.applicationId, packId, scope.applicationUserId],
    )
  ).rows[0];
  return row ? unitContentSchema.parse(row.content) : null;
}
