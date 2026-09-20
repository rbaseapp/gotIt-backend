import { Router } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import { withTransaction } from '../../shared/database/transaction.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { CaptureService } from '../capture/capture.service.js';
import { parseInput, saveSchema, uuidSchema } from '../capture/capture.validation.js';
import { pageSchema } from '../library/library.validation.js';
import { scopeValues } from '../library/library.repository.js';
import { ESTABLISHED_REVIEW_STAGE } from '../learning/learning.policy.js';

export const importSchema = z
  .object({
    format: z.literal('capture_requests_v1'),
    entries: z
      .array(z.object({ eventId: uuidSchema, capture: saveSchema }).strict())
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.entries.map((e) => e.eventId)).size !== v.entries.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate event IDs' });
    for (const entry of v.entries)
      if (entry.capture.clientEventId && entry.capture.clientEventId !== entry.eventId)
        ctx.addIssue({ code: 'custom', message: 'Capture event mismatch' });
  });
export function createTransferRoutes(pool: Pool, capture: CaptureService) {
  const router = Router();
  router.get('/export', async (req, res) => {
    const page = parseInput(pageSchema, req.query),
      scope = req.gotitAuth!;
    const data = await withTransaction(
      pool,
      async (tx) => {
        const rows = (
          await tx.query(
            `SELECT i.id,i.source_text AS "sourceText",i.source_language_code AS "sourceLanguageCode",i.translation_language_code AS "translationLanguageCode",i.item_type AS "itemType",i.part_of_speech AS "partOfSpeech",i.user_status AS "userStatus",i.learning_status AS "learningStatus",i.mastery_source AS "masterySource",i.user_priority AS "userPriority",i.manual_hard AS "manualHard",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('text',t.translation_text,'isPrimary',t.is_primary,'sourceKind',t.source_kind,'isUserEdited',t.is_user_edited) ORDER BY is_primary DESC,t.id) FROM product_gotit.item_translations t WHERE t.application_id=i.application_id AND t.application_user_id=i.application_user_id AND t.learning_item_id=i.id AND t.is_current),'[]'::jsonb) translations,
        i.learning_revision AS "learningRevision",i.overall_mastery_score::float8 AS "overallMasteryScore",i.review_stage AS "reviewStage",
        CASE WHEN i.learning_status='mastered' AND i.review_stage>=${ESTABLISHED_REVIEW_STAGE} THEN 'established' WHEN i.learning_status='mastered' THEN 'learned' ELSE 'acquiring' END AS "retentionLevel",
        i.next_review_at AS "nextReviewAt",i.last_practiced_at AS "lastPracticedAt",
        (SELECT count(*)::integer FROM product_gotit.item_occurrences o WHERE o.application_id=i.application_id AND o.application_user_id=i.application_user_id AND o.learning_item_id=i.id) AS "occurrenceCount",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('skillType',p.skill_type,'masteryScore',p.mastery_score,'confidence',p.confidence,'attemptCount',p.attempt_count,'successCount',p.success_count,'failureCount',p.failure_count,'lastAttemptAt',p.last_attempt_at,'algorithmVersion',p.algorithm_version) ORDER BY p.skill_type) FROM product_gotit.item_skill_progress p WHERE p.application_id=i.application_id AND p.application_user_id=i.application_user_id AND p.learning_item_id=i.id),'[]'::jsonb) skills,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',t.id,'name',t.name) ORDER BY t.id) FROM product_gotit.learning_item_tags a JOIN product_gotit.tags t ON t.id=a.tag_id AND t.application_id=a.application_id AND t.application_user_id=a.application_user_id WHERE a.application_id=i.application_id AND a.application_user_id=i.application_user_id AND a.learning_item_id=i.id),'[]'::jsonb) tags
        FROM product_gotit.learning_items i WHERE application_id=$1 AND application_user_id=$2 AND deleted_at IS NULL AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4`,
            [...scopeValues(scope), page.cursor ?? null, page.limit + 1],
          )
        ).rows;
        return {
          format: 'learning_library_v1',
          items: rows.slice(0, page.limit),
          nextCursor: rows.length > page.limit ? rows[page.limit - 1]!.id : null,
        };
      },
      true,
    );
    res.json({ ...data, requestId: req.id });
  });
  router.post('/import', async (req, res) => {
    const input = parseInput(importSchema, req.body),
      results = [],
      deadline = Date.now() + 60000;
    for (const entry of input.entries) {
      if (Date.now() + 15000 > deadline) {
        results.push({
          eventId: entry.eventId,
          status: 'failed',
          error: { code: 'IMPORT_DEADLINE' },
        });
        continue;
      }
      try {
        results.push({
          eventId: entry.eventId,
          status: 'succeeded',
          capture: await capture.save(req.gotitAuth!, entry.eventId, entry.capture),
        });
      } catch (error) {
        results.push({
          eventId: entry.eventId,
          status: 'failed',
          error: { code: error instanceof AppError ? error.code : 'INTERNAL_ERROR' },
        });
      }
    }
    res
      .status(results.some((r) => r.status === 'failed') ? 207 : 200)
      .json({ results, requestId: req.id });
  });
  return router;
}
