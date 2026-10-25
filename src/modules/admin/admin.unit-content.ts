import { z } from 'zod';
import { lessonMaterialSchema } from '../courses/lesson-material.schema.js';
import type { DatabaseTransaction } from '../../shared/database/transaction.js';
import type { ProfileScope } from '../profile/profile.types.js';
import { teacherStations } from '../word-packs/teacher-stations.js';
import { authoredMaterialIssue } from '../private-lessons/private-lesson.planner.js';

const stationSetting = z
  .object({
    requiredWords: z.number().int().min(1).max(100),
    durationMinutes: z.number().int().min(2).max(20),
  })
  .strict();

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
    stationSettings: z
      .object({
        supported: stationSetting.optional(),
        midpoint: stationSetting.optional(),
        review: stationSetting.optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const step of teacherStations(value.entries.length, 0, value.stationSettings)) {
      const issue = authoredMaterialIssue(value.materials[step.station], step.durationMinutes * 60);
      if (issue)
        ctx.addIssue({
          code: 'custom',
          path: ['materials', step.station, 'adaptationPolicy'],
          message: issue,
        });
    }
    if (!value.stationSettings) return;
    const stations = teacherStations(value.entries.length, 0, value.stationSettings);
    for (let i = 0; i < stations.length; i++) {
      const step = stations[i]!;
      if (
        step.requiredWords > value.entries.length ||
        (i > 0 && step.requiredWords < stations[i - 1]!.requiredWords) ||
        (step.station === 'review' && step.requiredWords !== value.entries.length)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['stationSettings', step.station, 'requiredWords'],
          message: 'Keep word thresholds in order and require all words for the final meeting',
        });
    }
  });
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
