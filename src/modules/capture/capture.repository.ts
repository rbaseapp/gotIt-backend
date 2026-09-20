import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryConfig, QueryResultRow } from 'pg';
import { z } from 'zod';
import type { ProfileScope } from '../profile/profile.types.js';
import type { ProviderFacts } from '../enrichment/enrichment.types.js';
import { fingerprint } from '../enrichment/selection-proof.js';
import type { ProviderTrace } from '../enrichment/enrichment.registry.js';
import { AppError } from '../../shared/errors/app-error.js';
import { lookupText, type SaveInput } from './capture.validation.js';
import { ESTABLISHED_REVIEW_STAGE } from '../learning/learning.policy.js';

const captureSchema = z
  .object({
    outcome: z.enum(['created', 'created_new_sense', 'merged']),
    learningItemId: z.uuid(),
    occurrenceId: z.uuid(),
    sourceText: z.string(),
    sourceLanguageCode: z.string(),
    translationLanguageCode: z.string(),
    primaryTranslation: z.string(),
    userStatus: z.enum(['active', 'paused', 'archived']),
    learningStatus: z.enum(['new', 'learning', 'reviewing', 'mastered']),
    capturedAt: z.iso.datetime(),
  })
  .strict();
const receiptSchema = z
  .object({
    version: z.literal(1),
    httpStatus: z.union([z.literal(200), z.literal(201)]),
    capture: captureSchema,
  })
  .strict();
export type CaptureResult = {
  capture: z.output<typeof captureSchema>;
  httpStatus: 200 | 201;
  replayed: boolean;
};
type ItemRow = QueryResultRow & {
  id: string;
  source_text: string;
  normalized_source_text: string;
  source_language_code: string;
  translation_language_code: string;
  user_status: 'active' | 'paused' | 'archived';
  learning_status: 'new' | 'learning' | 'reviewing' | 'mastered';
};
const scoped = (scope: ProfileScope) => [scope.applicationId, scope.applicationUserId];
const notFound = () => new AppError(404, 'NOT_FOUND', 'Learning item not found');
const boundedQuery = (
  text: string,
  values: unknown[],
  timeout: number,
): QueryConfig & { query_timeout: number } => ({ text, values, query_timeout: timeout });

class Transaction {
  private readonly deadline = Date.now() + 10000;
  constructor(readonly client: PoolClient) {}
  async query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
    const remaining = this.deadline - Date.now();
    if (remaining <= 0)
      throw new AppError(
        503,
        'CAPTURE_TEMPORARILY_UNAVAILABLE',
        'Capture database deadline exceeded',
      );
    const timeout = Math.min(5000, remaining);
    await this.client.query(
      boundedQuery(
        `SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)`,
        [`${timeout}ms`, `${Math.min(3000, timeout)}ms`],
        timeout,
      ),
    );
    const queryBudget = Math.min(timeout, this.deadline - Date.now());
    if (queryBudget <= 0)
      throw new AppError(
        503,
        'CAPTURE_TEMPORARILY_UNAVAILABLE',
        'Capture database deadline exceeded',
      );
    return this.client.query<T>(boundedQuery(text, values, queryBudget));
  }
  async lock(parts: string[]) {
    await this.query('SELECT pg_advisory_xact_lock($1::bigint)', [
      BigInt.asIntN(64, BigInt(`0x${fingerprint(parts).slice(0, 16)}`)).toString(10),
    ]);
  }
}

export class CaptureRepository {
  constructor(private readonly pool: Pool) {}
  private async connect(): Promise<PoolClient> {
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.pool.connect().then((client) => {
          if (timedOut) {
            client.release();
            throw new Error('Pool deadline');
          }
          return client;
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new Error('Pool deadline'));
          }, 3000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async transaction<T>(
    operation: (tx: Transaction) => Promise<T>,
    readOnly = false,
  ): Promise<T> {
    let client: PoolClient | undefined;
    let destroy = false;
    try {
      client = await this.connect();
      await client.query(
        boundedQuery(
          readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN',
          [],
          3000,
        ),
      );
      const tx = new Transaction(client);
      const result = await operation(tx);
      await tx.query('COMMIT');
      return result;
    } catch (error) {
      if (client) {
        try {
          await client.query(boundedQuery('ROLLBACK', [], 1000));
        } catch {
          destroy = true;
        }
      }
      if (error instanceof AppError) throw error;
      // Never pass SQL messages/parameters or content-bearing errors to HTTP logging.
      throw new AppError(
        503,
        'CAPTURE_TEMPORARILY_UNAVAILABLE',
        'Capture database is temporarily unavailable',
      );
    } finally {
      client?.release(destroy);
    }
  }
  private async candidates(
    tx: Transaction,
    scope: ProfileScope,
    source: string,
    sourceLanguage: string,
    targetLanguage: string,
  ) {
    const result = await tx.query(
      `SELECT li.id AS "learningItemId", li.source_text AS "sourceText",
      li.user_status AS "userStatus", li.learning_status AS "learningStatus",
      (SELECT translation_text FROM product_gotit.item_translations t WHERE t.application_id=li.application_id
       AND t.application_user_id=li.application_user_id AND t.learning_item_id=li.id AND t.is_current AND t.is_primary) AS "primaryTranslation",
      ARRAY(SELECT translation_text FROM product_gotit.item_translations t WHERE t.application_id=li.application_id
       AND t.application_user_id=li.application_user_id AND t.learning_item_id=li.id AND t.is_current AND NOT t.is_primary ORDER BY t.created_at,t.id LIMIT 10) AS variants
      FROM product_gotit.learning_items li WHERE li.application_id=$1 AND li.application_user_id=$2
      AND li.normalized_source_text=$3 AND li.source_language_code=$4 AND li.translation_language_code=$5
      AND li.deleted_at IS NULL ORDER BY li.updated_at DESC, li.id LIMIT 21`,
      [...scoped(scope), lookupText(source), sourceLanguage, targetLanguage],
    );
    return { items: result.rows.slice(0, 20), hasMore: result.rows.length > 20 };
  }
  async findCandidates(
    scope: ProfileScope,
    source: string,
    sourceLanguage: string,
    targetLanguage: string,
  ) {
    return this.transaction((tx) =>
      this.candidates(tx, scope, source, sourceLanguage, targetLanguage),
    );
  }
  async recordEnrichment(
    scope: ProfileScope,
    trace: ProviderTrace,
    targetLanguage: string,
  ): Promise<string> {
    return this.transaction(async (tx) => {
      const id = randomUUID();
      await tx.query(
        `INSERT INTO product_gotit.enrichment_runs
        (id,application_id,application_user_id,operation,provider_type,provider_name,provider_model,status,latency_ms,input_language_code,output_language_code)
        VALUES ($1,$2,$3,'capture_preview',$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          ...scoped(scope),
          trace.provider.kind,
          trace.provider.id,
          trace.profile.model,
          trace.status,
          trace.latencyMs,
          trace.sourceLanguageCode,
          targetLanguage,
        ],
      );
      return id;
    });
  }
  async save(
    scope: ProfileScope,
    key: string,
    input: SaveInput,
    hash: string,
    verifyFacts: () => ProviderFacts | null,
  ): Promise<CaptureResult> {
    return this.transaction(async (tx) => {
      await tx.lock(['capture-event', ...scoped(scope), key]);
      const prior = await tx.query(
        `SELECT id,learning_item_id,capture_request_hash,capture_receipt FROM product_gotit.item_occurrences
        WHERE application_id=$1 AND application_user_id=$2 AND client_event_id=$3`,
        [...scoped(scope), key],
      );
      if (prior.rows[0]) {
        const row = prior.rows[0];
        if (row.capture_request_hash === null && row.capture_receipt === null)
          throw new AppError(
            409,
            'IDEMPOTENCY_LEGACY_EVENT',
            'Historical event has no replay receipt',
          );
        const parsed = receiptSchema.safeParse(row.capture_receipt);
        if (
          !parsed.success ||
          !/^[a-f0-9]{64}$/u.test(row.capture_request_hash ?? '') ||
          parsed.data.capture.occurrenceId !== row.id ||
          parsed.data.capture.learningItemId !== row.learning_item_id ||
          (parsed.data.capture.outcome === 'merged') !== (parsed.data.httpStatus === 200)
        ) {
          throw new AppError(500, 'INTERNAL_ERROR', 'Stored capture receipt is invalid');
        }
        if (row.capture_request_hash !== hash)
          throw new AppError(
            409,
            'IDEMPOTENCY_CONFLICT',
            'Event key was already used for another capture',
          );
        return { capture: parsed.data.capture, httpStatus: parsed.data.httpStatus, replayed: true };
      }
      // No receipt: only fully verified provenance may authorize domain writes.
      const facts = verifyFacts();
      if (!facts && input.item.phoneticText !== null)
        throw new AppError(
          400,
          'ENRICHMENT_SELECTION_INVALID',
          'Phonetics require verified provider provenance',
        );
      await tx.lock([
        'capture-lexical',
        ...scoped(scope),
        lookupText(input.item.sourceText),
        input.item.sourceLanguageCode,
        input.item.translationLanguageCode,
      ]);
      const decision = input.senseDecision;
      let item: ItemRow;
      if (decision.mode === 'merge') {
        const owned = await tx.query<ItemRow>(
          `SELECT * FROM product_gotit.learning_items
          WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL FOR UPDATE`,
          [...scoped(scope), decision.learningItemId],
        );
        if (!owned.rows[0]) throw notFound();
        item = owned.rows[0];
        if (
          item.normalized_source_text !== lookupText(input.item.sourceText) ||
          item.source_language_code !== input.item.sourceLanguageCode ||
          item.translation_language_code !== input.item.translationLanguageCode
        )
          throw new AppError(
            409,
            'MERGE_ITEM_CHANGED',
            'Learning item changed; request a new preview',
          );
      } else {
        if (decision.mode === 'auto') {
          const candidates = await this.candidates(
            tx,
            scope,
            input.item.sourceText,
            input.item.sourceLanguageCode,
            input.item.translationLanguageCode,
          );
          if (candidates.items.length)
            throw new AppError(
              409,
              'SENSE_SELECTION_REQUIRED',
              'Choose an existing meaning or confirm a new sense',
              { existingSenses: candidates },
            );
        }
        const created = await tx.query<ItemRow>(
          `INSERT INTO product_gotit.learning_items
          (application_id,application_user_id,source_text,normalized_source_text,source_language_code,translation_language_code,item_type,part_of_speech,phonetic_text,phonetic_scheme)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            ...scoped(scope),
            input.item.sourceText,
            lookupText(input.item.sourceText),
            input.item.sourceLanguageCode,
            input.item.translationLanguageCode,
            input.item.itemType,
            input.item.partOfSpeech,
            input.item.phoneticText,
            input.item.phoneticScheme,
          ],
        );
        item = created.rows[0]!;
      }
      if (facts) {
        const runs = await tx.query(
          `SELECT learning_item_id,provider_type,provider_name,provider_model,status,operation,input_language_code,output_language_code
          FROM product_gotit.enrichment_runs WHERE application_id=$1 AND application_user_id=$2 AND id=$3 FOR UPDATE`,
          [...scoped(scope), facts.runId],
        );
        const run = runs.rows[0];
        if (
          !run ||
          run.status !== 'succeeded' ||
          run.operation !== 'capture_preview' ||
          run.provider_type !== facts.providerType ||
          run.provider_name !== facts.providerName ||
          run.provider_model !== facts.providerModel ||
          run.input_language_code !== input.item.sourceLanguageCode ||
          run.output_language_code !== input.item.translationLanguageCode
        ) {
          throw new AppError(400, 'ENRICHMENT_SELECTION_INVALID', 'Invalid enrichment selection');
        }
        if (run.learning_item_id !== null && run.learning_item_id !== item.id)
          throw new AppError(
            409,
            'ENRICHMENT_SELECTION_ALREADY_USED',
            'Enrichment selection already belongs to another item',
          );
        await tx.query(
          `UPDATE product_gotit.enrichment_runs SET learning_item_id=$4
          WHERE application_id=$1 AND application_user_id=$2 AND id=$3`,
          [...scoped(scope), facts.runId, item.id],
        );
      }
      const primaryBefore = await tx.query(
        `SELECT translation_text FROM product_gotit.item_translations
        WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3 AND is_current AND is_primary`,
        [...scoped(scope), item.id],
      );
      const forms = (
        await tx.query(
          'SELECT normalized_text FROM product_gotit.item_translations WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3 AND is_current LIMIT 101',
          [...scoped(scope), item.id],
        )
      ).rows.map((row) => row.normalized_text as string);
      if (
        new Set([
          ...forms,
          ...[input.translation.text, ...input.translation.variants].map(lookupText),
        ]).size > 100
      )
        throw new AppError(
          409,
          'TRANSLATION_LIMIT',
          'An item supports at most 100 current accepted forms',
        );
      for (const text of [input.translation.text, ...input.translation.variants]) {
        await tx.query(
          `INSERT INTO product_gotit.item_translations
          (application_id,application_user_id,learning_item_id,translation_text,normalized_text,is_primary,source_kind,provider_name,provider_model,is_user_edited)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (application_id,application_user_id,learning_item_id,normalized_text) DO UPDATE SET is_current=true`,
          [
            ...scoped(scope),
            item.id,
            text,
            lookupText(text),
            !primaryBefore.rows.length && text === input.translation.text,
            facts?.providerType ?? 'user',
            facts?.providerName ?? null,
            facts?.providerModel ?? null,
            !facts,
          ],
        );
      }
      if (!primaryBefore.rows.length) {
        // Legacy item may already contain the accepted translation as a variant.
        await tx.query(
          `UPDATE product_gotit.item_translations SET is_primary=true
          WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3 AND normalized_text=$4 AND NOT is_primary`,
          [...scoped(scope), item.id, lookupText(input.translation.text)],
        );
      }
      await tx.query(
        `INSERT INTO product_gotit.item_skill_progress
        (application_id,application_user_id,learning_item_id,skill_type,algorithm_version)
        SELECT $1,$2,$3,skill,'pending-learning-engine' FROM unnest(ARRAY['recognition','recall','listening','spelling','pronunciation']) skill
        ON CONFLICT (learning_item_id,skill_type) DO NOTHING`,
        [...scoped(scope), item.id],
      );
      if (facts && decision.mode !== 'merge') {
        for (const example of facts.candidate.examples) {
          await tx.query(
            `INSERT INTO product_gotit.item_examples
            (application_id,application_user_id,learning_item_id,example_text,source_kind,provider_name,provider_model,learning_revision)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              ...scoped(scope),
              item.id,
              example,
              facts.providerType,
              facts.providerName,
              facts.providerModel,
              item.learning_revision,
            ],
          );
        }
      }
      const primary = await tx.query(
        `SELECT translation_text FROM product_gotit.item_translations
        WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3 AND is_current AND is_primary`,
        [...scoped(scope), item.id],
      );
      const capture = captureSchema.parse({
        outcome:
          decision.mode === 'merge'
            ? 'merged'
            : decision.mode === 'create_new_sense'
              ? 'created_new_sense'
              : 'created',
        learningItemId: item.id,
        occurrenceId: randomUUID(),
        sourceText: item.source_text,
        sourceLanguageCode: item.source_language_code,
        translationLanguageCode: item.translation_language_code,
        primaryTranslation: primary.rows[0]?.translation_text,
        userStatus: item.user_status,
        learningStatus: item.learning_status,
        capturedAt: input.context.capturedAt ?? new Date().toISOString(),
      });
      const httpStatus = decision.mode === 'merge' ? 200 : 201;
      const context = input.context;
      await tx.query(
        `INSERT INTO product_gotit.item_occurrences
        (id,application_id,application_user_id,learning_item_id,source_type,selected_text,sentence_text,paragraph_text,page_title,page_url,page_hostname,captured_at,client_event_id,capture_request_hash,capture_receipt,learning_revision)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          capture.occurrenceId,
          ...scoped(scope),
          item.id,
          context.sourceType,
          context.selectedText,
          context.sentenceText,
          context.paragraphText,
          context.pageTitle,
          context.pageUrl,
          context.pageUrl ? new URL(context.pageUrl).hostname : null,
          capture.capturedAt,
          key,
          hash,
          JSON.stringify({ version: 1, httpStatus, capture }),
          item.learning_revision,
        ],
      );
      if (decision.mode === 'merge')
        await tx.query(
          `UPDATE product_gotit.learning_items SET updated_at=now()
        WHERE application_id=$1 AND application_user_id=$2 AND id=$3`,
          [...scoped(scope), item.id],
        );
      return { capture, httpStatus, replayed: false };
    });
  }
  async getDetail(scope: ProfileScope, id: string) {
    return this.transaction(async (tx) => {
      const result = await tx.query(
        `SELECT id,source_text AS "sourceText",source_language_code AS "sourceLanguageCode",
        translation_language_code AS "translationLanguageCode",item_type AS "itemType",part_of_speech AS "partOfSpeech",
        phonetic_text AS "phoneticText",phonetic_scheme AS "phoneticScheme",user_status AS "userStatus",learning_status AS "learningStatus",
        user_priority AS "userPriority",manual_hard AS "manualHard",system_difficulty::float8 AS "systemDifficulty",
        overall_mastery_score::float8 AS "overallMasteryScore",mastery_source AS "masterySource",review_stage AS "reviewStage",
        CASE WHEN learning_status='mastered' AND review_stage>=${ESTABLISHED_REVIEW_STAGE} THEN 'established' WHEN learning_status='mastered' THEN 'learned' ELSE 'acquiring' END AS "retentionLevel",learning_revision AS "learningRevision",
        next_review_at AS "nextReviewAt",last_practiced_at AS "lastPracticedAt",created_at AS "createdAt",updated_at AS "updatedAt"
        FROM product_gotit.learning_items WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL`,
        [...scoped(scope), id],
      );
      if (!result.rows[0]) throw notFound();
      const translations = await tx.query(
        `SELECT id,translation_text AS text,is_primary AS "isPrimary",source_kind AS "sourceKind",
        provider_name AS "providerName",provider_model AS "providerModel",is_user_edited AS "isUserEdited"
        FROM product_gotit.item_translations WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3 AND is_current ORDER BY is_primary DESC,created_at,id`,
        [...scoped(scope), id],
      );
      const skills = await tx.query(
        `SELECT skill_type AS "skillType",mastery_score::float8 AS "masteryScore",confidence::float8 AS confidence,
        attempt_count AS "attemptCount",success_count AS "successCount",failure_count AS "failureCount",last_attempt_at AS "lastAttemptAt"
        FROM product_gotit.item_skill_progress WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3 ORDER BY skill_type`,
        [...scoped(scope), id],
      );
      const occurrences = await tx.query(
        `SELECT count(*)::integer AS count FROM product_gotit.item_occurrences
        WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3`,
        [...scoped(scope), id],
      );
      return {
        ...result.rows[0],
        translations: translations.rows,
        skills: skills.rows,
        occurrenceCount: occurrences.rows[0]!.count,
      };
    }, true);
  }
}
