import type { Pool } from 'pg';
import { z } from 'zod';
import { withTransaction, type DatabaseTransaction } from '../../shared/database/transaction.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { ProfileScope } from '../profile/profile.types.js';
import { lookupText, sameBaseLanguage } from '../capture/capture.validation.js';
import { fingerprint } from '../enrichment/selection-proof.js';
import {
  DEFAULT_LEARNING_POLICY,
  ESTABLISHED_REVIEW_STAGE,
  LEARNED_REVIEW_STAGE,
  masteryRequirements,
  projectEvidence,
  type LearningPolicy,
} from '../learning/learning.policy.js';
import type { ListInput, EditInput, BulkInput } from './library.validation.js';
export const scopeValues = (scope: ProfileScope) => [scope.applicationId, scope.applicationUserId];
export const itemNotFound = () => new AppError(404, 'NOT_FOUND', 'Learning item not found');
const cursorSchema = z
  .object({
    id: z.uuid(),
    value: z.union([z.string().max(1000), z.number()]),
    filterHash: z.string().length(64),
  })
  .strict();
const fields = `li.id,li.source_text AS "sourceText",li.source_language_code AS "sourceLanguageCode",
  li.translation_language_code AS "translationLanguageCode",li.item_type AS "itemType",li.user_status AS "userStatus",
  li.learning_status AS "learningStatus",li.user_priority AS "userPriority",li.manual_hard AS "manualHard",
  li.overall_mastery_score::float8 AS "overallMasteryScore",li.review_stage AS "reviewStage",
  CASE WHEN li.learning_status='mastered' AND li.review_stage>=${ESTABLISHED_REVIEW_STAGE} THEN 'established' WHEN li.learning_status='mastered' THEN 'learned' ELSE 'acquiring' END AS "retentionLevel",
  li.next_review_at AS "nextReviewAt",li.created_at AS "createdAt",li.updated_at AS "updatedAt",
  (SELECT translation_text FROM product_gotit.item_translations t WHERE t.application_id=li.application_id
   AND t.application_user_id=li.application_user_id AND t.learning_item_id=li.id AND t.is_current AND is_primary) AS "primaryTranslation"`;
export function itemSnapshot(row: Record<string, unknown>, translations: unknown) {
  return fingerprint({
    sourceText: row.source_text,
    sourceLanguageCode: row.source_language_code,
    translationLanguageCode: row.translation_language_code,
    userStatus: row.user_status,
    deletedAt: row.deleted_at,
    translations,
    learningRevision: row.learning_revision,
  });
}
export class LibraryRepository {
  constructor(
    readonly pool: Pool,
    readonly policy: LearningPolicy = DEFAULT_LEARNING_POLICY,
  ) {}
  private async requirements(tx: DatabaseTransaction, scope: ProfileScope, ids: string[]) {
    if (!ids.length) return new Map<string, ReturnType<typeof masteryRequirements>>();
    const timezone = (
        await tx.query(
          'SELECT timezone FROM product_gotit.user_profiles WHERE application_id=$1 AND application_user_id=$2',
          scopeValues(scope),
        )
      ).rows[0]?.timezone as string | undefined,
      rows = (
        await tx.query(
          `WITH active_history AS(
             SELECT a.learning_item_id,a.id,a.score::float8 score,a.created_at,
               (a.created_at AT TIME ZONE $4)::date activity_day
             FROM product_gotit.practice_attempts a
             JOIN product_gotit.learning_items current ON current.application_id=a.application_id
               AND current.application_user_id=a.application_user_id AND current.id=a.learning_item_id
             WHERE a.application_id=$1 AND a.application_user_id=$2 AND a.learning_item_id=ANY($3::uuid[])
               AND a.result<>'skipped' AND a.user_answer_text IS NOT NULL
               AND COALESCE(a.learning_revision,1)=current.learning_revision
               AND EXISTS(SELECT 1 FROM product_gotit.attempt_skill_effects effect
                 WHERE effect.practice_attempt_id=a.id AND effect.skill_type='recall'))
           SELECT li.id,li.learning_status,li.review_stage,
             (SELECT count(*)::integer FROM product_gotit.practice_attempts total
               WHERE total.application_id=li.application_id AND total.application_user_id=li.application_user_id
                 AND total.learning_item_id=li.id AND total.result<>'skipped'
                 AND COALESCE(total.learning_revision,1)=li.learning_revision) total_attempts,
             count(history.id) FILTER(WHERE history.score>=85)::integer successes,
             count(DISTINCT history.activity_day) FILTER(WHERE history.score>=85)::integer successful_days,
             ARRAY(SELECT score FROM(SELECT score,created_at,id FROM active_history recent
               WHERE recent.learning_item_id=li.id ORDER BY created_at DESC,id DESC LIMIT 10) recent
               ORDER BY created_at,id) scores
           FROM product_gotit.learning_items li
           LEFT JOIN active_history history ON history.learning_item_id=li.id
           WHERE li.application_id=$1 AND li.application_user_id=$2 AND li.id=ANY($3::uuid[])
           GROUP BY li.id`,
          [...scopeValues(scope), ids, timezone ?? 'UTC'],
        )
      ).rows;
    return new Map(
      rows.map((row) => {
        const activeRecallMasteryScore = projectEvidence(
          row.scores,
          row.successful_days,
        ).masteryScore;
        return [
          row.id,
          masteryRequirements(
            this.policy,
            {
              totalScoredAttempts: row.total_attempts,
              activeRecallSuccesses: row.successes,
              activeRecallCalendarDays: row.successful_days,
              activeRecallMasteryScore,
            },
            row.review_stage,
            row.learning_status,
          ),
        ];
      }),
    );
  }
  async list(scope: ProfileScope, input: ListInput) {
    return withTransaction(
      this.pool,
      async (tx) => {
        const { cursor, ...filters } = input,
          filterHash = fingerprint(filters);
        const parameters: unknown[] = scopeValues(scope),
          where = ['li.application_id=$1', 'li.application_user_id=$2'];
        const add = (clause: string, value: unknown) => {
          parameters.push(value);
          where.push(clause.replace('?', `$${parameters.length}`));
        };
        where.push(
          input.userStatus === 'deleted' ? 'li.deleted_at IS NOT NULL' : 'li.deleted_at IS NULL',
        );
        if (!['all', 'deleted'].includes(input.userStatus))
          add('li.user_status=?', input.userStatus);
        if (input.learningStatus) add('li.learning_status=?', input.learningStatus);
        if (input.sourceLanguageCode) add('li.source_language_code=?', input.sourceLanguageCode);
        if (input.translationLanguageCode)
          add('li.translation_language_code=?', input.translationLanguageCode);
        if (input.search)
          add(
            `li.normalized_source_text LIKE ? ESCAPE '\\'`,
            `%${lookupText(input.search).replace(/[\\%_]/gu, '\\$&')}%`,
          );
        if (input.difficult)
          where.push(
            input.difficult === 'true'
              ? '(li.manual_hard OR li.system_difficulty>=0.7)'
              : '(NOT li.manual_hard AND COALESCE(li.system_difficulty,0)<0.7)',
          );
        if (input.highPriority)
          add('li.user_priority=?', input.highPriority === 'true' ? 'high' : 'normal');
        if (input.due)
          where.push(
            input.due === 'true'
              ? 'li.next_review_at<=now()'
              : '(li.next_review_at IS NULL OR li.next_review_at>now())',
          );
        if (input.tagId)
          add(
            `EXISTS(SELECT 1 FROM product_gotit.learning_item_tags it WHERE it.application_id=li.application_id AND it.application_user_id=li.application_user_id AND it.learning_item_id=li.id AND it.tag_id=?)`,
            input.tagId,
          );
        if (input.packIds)
          add(
            `EXISTS(SELECT 1 FROM product_gotit.learning_item_pack_entries pack_link
              JOIN product_gotit.user_word_packs membership
                ON membership.application_id=pack_link.application_id
                AND membership.application_user_id=pack_link.application_user_id
                AND membership.pack_id=pack_link.pack_id AND membership.status='active'
              WHERE pack_link.application_id=li.application_id
                AND pack_link.application_user_id=li.application_user_id
                AND pack_link.learning_item_id=li.id AND pack_link.excluded_at IS NULL
                AND pack_link.pack_id=ANY(?::uuid[]))`,
            input.packIds,
          );
        const sorts = {
          recent: ['li.created_at', 'DESC', 'timestamptz'],
          alphabetical: ['li.normalized_source_text', 'ASC', 'text'],
          weakest: ['li.overall_mastery_score', 'ASC', 'numeric'],
          strongest: ['li.overall_mastery_score', 'DESC', 'numeric'],
          due_next: ["COALESCE(li.next_review_at,'infinity'::timestamptz)", 'ASC', 'timestamptz'],
          most_practiced: [
            `(SELECT count(*) FROM product_gotit.practice_attempts a WHERE a.application_id=li.application_id AND a.application_user_id=li.application_user_id AND a.learning_item_id=li.id)`,
            'DESC',
            'bigint',
          ],
        } as const;
        const [metric, direction, cast] = sorts[input.sort];
        if (cursor) {
          let claim: z.output<typeof cursorSchema>;
          try {
            claim = cursorSchema.parse(
              JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
            );
          } catch {
            throw new AppError(400, 'VALIDATION_ERROR', 'Invalid pagination cursor');
          }
          if (claim.filterHash !== filterHash)
            throw new AppError(400, 'VALIDATION_ERROR', 'Cursor filters changed');
          parameters.push(claim.value, claim.id);
          where.push(
            `(${metric},li.id) ${direction === 'ASC' ? '>' : '<'} ($${parameters.length - 1}::${cast},$${parameters.length}::uuid)`,
          );
        }
        parameters.push(input.limit + 1);
        const rows = (
          await tx.query(
            `SELECT ${fields},(${metric})::text AS cursor_value FROM product_gotit.learning_items li
      WHERE ${where.join(' AND ')} ORDER BY ${metric} ${direction},li.id ${direction} LIMIT $${parameters.length}`,
            parameters,
          )
        ).rows;
        const hasMore = rows.length > input.limit,
          selected = rows.slice(0, input.limit),
          last = selected.at(-1),
          requirements = await this.requirements(
            tx,
            scope,
            selected.map((row) => row.id),
          );
        return {
          items: selected.map(({ cursor_value, ...row }) => ({
            ...row,
            masteryRequirements: requirements.get(row.id),
          })),
          nextCursor:
            hasMore && last
              ? Buffer.from(
                  JSON.stringify({ id: last.id, value: last.cursor_value, filterHash }),
                ).toString('base64url')
              : null,
        };
      },
      true,
    );
  }
  async owned(tx: DatabaseTransaction, scope: ProfileScope, id: string, deleted = false) {
    const row = (
      await tx.query(
        `SELECT * FROM product_gotit.learning_items WHERE application_id=$1 AND application_user_id=$2 AND id=$3
      ${deleted ? '' : 'AND deleted_at IS NULL'} FOR UPDATE`,
        [...scopeValues(scope), id],
      )
    ).rows[0];
    if (!row) throw itemNotFound();
    return row;
  }
  async edit(scope: ProfileScope, id: string, input: EditInput) {
    return withTransaction(this.pool, async (tx) => {
      const initial = (
        await tx.query(
          `SELECT * FROM product_gotit.learning_items WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL`,
          [...scopeValues(scope), id],
        )
      ).rows[0];
      if (!initial) throw itemNotFound();
      const pairs = [
        [
          initial.normalized_source_text,
          initial.source_language_code,
          initial.translation_language_code,
        ],
        [
          lookupText(input.sourceText ?? initial.source_text),
          input.sourceLanguageCode ?? initial.source_language_code,
          input.translationLanguageCode ?? initial.translation_language_code,
        ],
      ];
      for (const pair of [...new Map(pairs.map((p) => [JSON.stringify(p), p])).values()].sort(
        (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ))
        await tx.lock(['capture-lexical', ...scopeValues(scope), ...pair]);
      const row = await this.owned(tx, scope, id);
      if (
        row.updated_at.getTime() !== initial.updated_at.getTime() ||
        (input.expectedUpdatedAt &&
          new Date(input.expectedUpdatedAt).getTime() !== row.updated_at.getTime())
      )
        throw new AppError(409, 'ITEM_CHANGED', 'Learning item changed; reload before editing');
      if (
        sameBaseLanguage(
          input.sourceLanguageCode ?? row.source_language_code,
          input.translationLanguageCode ?? row.translation_language_code,
        )
      )
        throw new AppError(
          400,
          'LANGUAGE_PAIR_INVALID',
          'Source and translation languages must differ',
        );
      const accepted = (
        await tx.query(
          'SELECT normalized_text FROM product_gotit.item_translations WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3 AND is_current',
          [...scopeValues(scope), id],
        )
      ).rows.map((r) => r.normalized_text as string);
      const semanticChange =
        (input.sourceText !== undefined &&
          lookupText(input.sourceText) !== row.normalized_source_text) ||
        (input.sourceLanguageCode !== undefined &&
          input.sourceLanguageCode !== row.source_language_code) ||
        (input.translationLanguageCode !== undefined &&
          input.translationLanguageCode !== row.translation_language_code) ||
        (input.translation !== undefined && !accepted.includes(lookupText(input.translation.text)));
      if (semanticChange && !input.translation)
        throw new AppError(
          400,
          'TRANSLATION_REQUIRED',
          'Semantic edits require an explicitly confirmed translation',
        );
      if (
        input.translationLanguageCode !== undefined &&
        input.translationLanguageCode !== row.translation_language_code &&
        !input.translation
      )
        throw new AppError(
          400,
          'TRANSLATION_REQUIRED',
          'Changing the translation language requires an accepted translation',
        );
      const columns: Record<string, string> = {
        sourceText: 'source_text',
        sourceLanguageCode: 'source_language_code',
        translationLanguageCode: 'translation_language_code',
        itemType: 'item_type',
        partOfSpeech: 'part_of_speech',
        userStatus: 'user_status',
        userPriority: 'user_priority',
        manualHard: 'manual_hard',
      };
      const values: unknown[] = scopeValues(scope);
      values.push(id);
      const sets = ['updated_at=clock_timestamp()'];
      for (const [key, column] of Object.entries(columns))
        if (input[key as keyof EditInput] !== undefined) {
          values.push(input[key as keyof EditInput]);
          sets.push(`${column}=$${values.length}`);
        }
      if (input.sourceText !== undefined) {
        values.push(lookupText(input.sourceText));
        sets.push(`normalized_source_text=$${values.length}`);
      }
      if (input.sourceText !== undefined || input.sourceLanguageCode !== undefined) {
        sets.push('phonetic_text=NULL', 'phonetic_scheme=NULL');
      }
      await tx.query(
        `UPDATE product_gotit.learning_items SET ${sets.join(',')} WHERE application_id=$1 AND application_user_id=$2 AND id=$3`,
        values,
      );
      if (semanticChange) {
        await tx.query(
          'UPDATE product_gotit.item_translations SET is_current=false,is_primary=false WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3',
          [...scopeValues(scope), id],
        );
        await tx.query(
          `UPDATE product_gotit.learning_items SET learning_revision=learning_revision+1,overall_mastery_score=0,learning_status='new',mastery_source=NULL,review_stage=0,next_review_at=NULL,last_practiced_at=NULL,first_mastered_at=NULL,last_mastered_at=NULL,system_difficulty=NULL WHERE application_id=$1 AND application_user_id=$2 AND id=$3`,
          [...scopeValues(scope), id],
        );
        await tx.query(
          `UPDATE product_gotit.item_skill_progress SET mastery_score=0,confidence=0,attempt_count=0,success_count=0,failure_count=0,last_attempt_at=NULL,last_success_at=NULL,last_failure_at=NULL,algorithm_version='gotit-v1-new-revision',updated_at=now() WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3`,
          [...scopeValues(scope), id],
        );
        await tx.query(
          `INSERT INTO product_gotit.learning_algorithm_events(application_id,application_user_id,learning_item_id,event_type,from_status,to_status,from_stage,to_stage,reason_code,algorithm_version) VALUES($1,$2,$3,'semantic_edit',$4,'new',$5,0,'learning_revision_changed','gotit-v1')`,
          [...scopeValues(scope), id, row.learning_status, row.review_stage],
        );
      }
      if (input.translation) {
        const forms = [input.translation.text, ...input.translation.variants].map(lookupText);
        if (new Set(forms).size !== forms.length)
          throw new AppError(400, 'VALIDATION_ERROR', 'Duplicate translations');
        await tx.query(
          `UPDATE product_gotit.item_translations SET is_primary=false,is_current=false WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3`,
          [...scopeValues(scope), id],
        );
        for (const [index, text] of [
          input.translation.text,
          ...input.translation.variants,
        ].entries())
          await tx.query(
            `INSERT INTO product_gotit.item_translations
        (application_id,application_user_id,learning_item_id,translation_text,normalized_text,is_primary,source_kind,is_user_edited)
        VALUES($1,$2,$3,$4,$5,$6,'user',true) ON CONFLICT(application_id,application_user_id,learning_item_id,normalized_text)
        DO UPDATE SET translation_text=EXCLUDED.translation_text,is_primary=EXCLUDED.is_primary,is_user_edited=true,is_current=true,updated_at=now()`,
            [...scopeValues(scope), id, text, lookupText(text), index === 0],
          );
      }
      return {
        id,
        learningRevision: row.learning_revision + (semanticChange ? 1 : 0),
        progressReset: semanticChange,
      };
    });
  }
  async bulk(scope: ProfileScope, input: BulkInput) {
    return withTransaction(this.pool, async (tx) => {
      const rows = [];
      for (const id of [...input.ids].sort())
        rows.push(await this.owned(tx, scope, id, input.action === 'restore'));
      const assignments: Record<BulkInput['action'], string> = {
        pause: "user_status='paused'",
        resume: "user_status='active'",
        archive: "user_status='archived'",
        delete: 'deleted_at=now()',
        restore: 'deleted_at=NULL',
        mark_mastered: `learning_status='mastered',mastery_source='user',review_stage=GREATEST(review_stage,${LEARNED_REVIEW_STAGE}),next_review_at=now()+interval '7 days',first_mastered_at=COALESCE(first_mastered_at,now()),last_mastered_at=now()`,
        return_to_learning:
          "learning_status='learning',mastery_source=NULL,review_stage=0,next_review_at=now()",
        high_priority: "user_priority='high'",
        normal_priority: "user_priority='normal'",
        mark_hard: 'manual_hard=true',
        clear_hard: 'manual_hard=false',
      };
      for (const row of rows) {
        await tx.query(
          `UPDATE product_gotit.learning_items SET ${assignments[input.action]},updated_at=clock_timestamp()
      WHERE application_id=$1 AND application_user_id=$2 AND id=$3`,
          [...scopeValues(scope), row.id],
        );
        if (['mark_mastered', 'return_to_learning'].includes(input.action))
          await tx.query(
            `INSERT INTO product_gotit.learning_algorithm_events
        (application_id,application_user_id,learning_item_id,event_type,from_status,to_status,from_stage,to_stage,reason_code,algorithm_version)
        VALUES($1,$2,$3,'manual_override',$4,$5,$6,$7,$8,'gotit-v1')`,
            [
              ...scopeValues(scope),
              row.id,
              row.learning_status,
              input.action === 'mark_mastered' ? 'mastered' : 'learning',
              row.review_stage,
              input.action === 'mark_mastered'
                ? Math.max(LEARNED_REVIEW_STAGE, row.review_stage)
                : 0,
              input.action,
            ],
          );
      }
      return { ids: input.ids, action: input.action };
    });
  }
  async tags(scope: ProfileScope, limit = 30, cursor?: string) {
    return withTransaction(
      this.pool,
      async (tx) => {
        const rows = (
          await tx.query(
            'SELECT id,name FROM product_gotit.tags WHERE application_id=$1 AND application_user_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT $4',
            [...scopeValues(scope), cursor ?? null, limit + 1],
          )
        ).rows;
        return {
          tags: rows.slice(0, limit),
          nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
        };
      },
      true,
    );
  }
  async saveTag(scope: ProfileScope, name: string, id?: string) {
    return withTransaction(this.pool, async (tx) => {
      await tx.lock(['tag', ...scopeValues(scope), lookupText(name)]);
      const existing = (
        await tx.query(
          `SELECT id FROM product_gotit.tags WHERE application_id=$1 AND application_user_id=$2 AND normalized_name=$3`,
          [...scopeValues(scope), lookupText(name)],
        )
      ).rows[0];
      if (id) {
        if (existing && existing.id !== id)
          throw new AppError(409, 'TAG_EXISTS', 'Tag already exists');
        const result = await tx.query(
          `UPDATE product_gotit.tags SET name=$4,normalized_name=$5,updated_at=now() WHERE application_id=$1 AND application_user_id=$2 AND id=$3 RETURNING id,name`,
          [...scopeValues(scope), id, name, lookupText(name)],
        );
        if (!result.rows[0]) throw new AppError(404, 'NOT_FOUND', 'Tag not found');
        return result.rows[0];
      }
      return (
        await tx.query(
          `INSERT INTO product_gotit.tags(application_id,application_user_id,name,normalized_name) VALUES($1,$2,$3,$4)
      ON CONFLICT(application_id,application_user_id,normalized_name) DO UPDATE SET name=product_gotit.tags.name RETURNING id,name`,
          [...scopeValues(scope), name, lookupText(name)],
        )
      ).rows[0];
    });
  }
  async deleteTag(scope: ProfileScope, id: string) {
    return withTransaction(this.pool, async (tx) => {
      const result = await tx.query(
        'DELETE FROM product_gotit.tags WHERE application_id=$1 AND application_user_id=$2 AND id=$3 RETURNING id',
        [...scopeValues(scope), id],
      );
      if (!result.rowCount) throw new AppError(404, 'NOT_FOUND', 'Tag not found');
      return { id };
    });
  }
  async setTags(scope: ProfileScope, id: string, ids: string[]) {
    return withTransaction(this.pool, async (tx) => {
      await this.owned(tx, scope, id);
      const tags = await tx.query(
        `SELECT id FROM product_gotit.tags WHERE application_id=$1 AND application_user_id=$2 AND id=ANY($3::uuid[]) FOR SHARE`,
        [...scopeValues(scope), ids],
      );
      if (tags.rows.length !== ids.length) throw new AppError(404, 'NOT_FOUND', 'Tag not found');
      await tx.query(
        'DELETE FROM product_gotit.learning_item_tags WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3',
        [...scopeValues(scope), id],
      );
      for (const tagId of ids)
        await tx.query(
          `INSERT INTO product_gotit.learning_item_tags(application_id,application_user_id,learning_item_id,tag_id) VALUES($1,$2,$3,$4)`,
          [...scopeValues(scope), id, tagId],
        );
      return { id, tagIds: ids };
    });
  }
  async occurrences(scope: ProfileScope, id: string, limit: number, cursor?: string) {
    return withTransaction(
      this.pool,
      async (tx) => {
        const owned = await tx.query(
          'SELECT id FROM product_gotit.learning_items WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL',
          [...scopeValues(scope), id],
        );
        if (!owned.rowCount) throw itemNotFound();
        const rows = (
          await tx.query(
            `SELECT id,source_type AS "sourceType",selected_text AS "selectedText",sentence_text AS "sentenceText",paragraph_text AS "paragraphText",page_title AS "pageTitle",page_url AS "pageUrl",captured_at AS "capturedAt"
      FROM product_gotit.item_occurrences WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3 AND ($4::uuid IS NULL OR id>$4) ORDER BY id LIMIT $5`,
            [...scopeValues(scope), id, cursor ?? null, limit + 1],
          )
        ).rows;
        return {
          items: rows.slice(0, limit),
          nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
        };
      },
      true,
    );
  }
  async translations(
    scope: ProfileScope,
    id: string,
    limit: number,
    cursor?: string,
    includeHistorical = false,
  ) {
    return withTransaction(
      this.pool,
      async (tx) => {
        if (
          !(
            await tx.query(
              'SELECT id FROM product_gotit.learning_items WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL',
              [...scopeValues(scope), id],
            )
          ).rowCount
        )
          throw itemNotFound();
        const rows = (
          await tx.query(
            `SELECT id,translation_text AS text,is_primary AS "isPrimary",is_current AS "isCurrent",source_kind AS "sourceKind",is_user_edited AS "isUserEdited",provider_name AS "providerName",provider_model AS "providerModel" FROM product_gotit.item_translations WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3 AND ($4::uuid IS NULL OR id>$4) AND ($5::boolean OR is_current) ORDER BY id LIMIT $6`,
            [...scopeValues(scope), id, cursor ?? null, includeHistorical, limit + 1],
          )
        ).rows;
        return {
          translations: rows.slice(0, limit),
          nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
        };
      },
      true,
    );
  }
  async examples(scope: ProfileScope, id: string, input?: string[]) {
    return withTransaction(this.pool, async (tx) => {
      const item = await this.owned(tx, scope, id);
      if (input) {
        await tx.query(
          "DELETE FROM product_gotit.item_examples WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3 AND source_kind='user' AND learning_revision=$4",
          [...scopeValues(scope), id, item.learning_revision],
        );
        for (const text of input)
          await tx.query(
            `INSERT INTO product_gotit.item_examples(application_id,application_user_id,learning_item_id,example_text,source_kind,is_user_edited,learning_revision) VALUES($1,$2,$3,$4,'user',true,$5)`,
            [...scopeValues(scope), id, text, item.learning_revision],
          );
      }
      return (
        await tx.query(
          `SELECT id,example_text AS text,source_kind AS "sourceKind",is_user_edited AS "isUserEdited" FROM product_gotit.item_examples WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3 AND learning_revision=$4 ORDER BY created_at,id LIMIT 100`,
          [...scopeValues(scope), id, item.learning_revision],
        )
      ).rows;
    });
  }
}
