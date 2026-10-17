import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { AppError } from '../../shared/errors/app-error.js';
import { withTransaction } from '../../shared/database/transaction.js';
import { lookupText } from '../capture/capture.validation.js';
import { adminRuntimeContext } from '../admin/admin.context.js';
import { providerFailureCode } from '../enrichment/providers/http.js';
import {
  conceptDescriptorSchema,
  type ConceptAssignmentProvider,
  type ConceptAssignmentInput,
  type ConceptCandidate,
  type ConceptDescriptor,
} from './concept-assignment.provider.js';

/** Candidate recall only: vowel marks never establish semantic equivalence. */
export function conceptSearchText(language: string, text: string) {
  const normalized = lookupText(text),
    base = language.toLowerCase().split('-')[0];
  if (base === 'ar') return normalized.replace(/[\u0640\u064b-\u065f\u0670\u06d6-\u06ed]/gu, '');
  if (base === 'he')
    return normalized.replace(/[\u0591-\u05bd\u05bf\u05c1\u05c2\u05c4\u05c5\u05c7]/gu, '');
  return normalized;
}
type Job = {
  application_id: string;
  application_user_id: string;
  learning_item_id: string;
  learning_revision: number;
  generation: number;
  claim_id: string;
  attempts: number;
  descriptor: unknown;
  priority: number;
};
type Queryable = {
  query(text: string, values: unknown[]): Promise<{ rows: Record<string, any>[] }>;
};
const keys = (job: Job) => [job.application_id, job.application_user_id, job.learning_item_id];
const snapshot = (candidates: ConceptCandidate[]) =>
  createHash('sha256').update(JSON.stringify(candidates)).digest('hex');

export class ConceptAssignmentService {
  private running: Promise<unknown> | undefined;
  private stopping = false;
  constructor(
    private readonly db: Pool,
    private readonly provider?: ConceptAssignmentProvider,
    private readonly warn: (code: string) => void = () => {},
  ) {}
  kick() {
    if (this.stopping || this.running || !this.provider) return;
    this.running = this.run()
      .catch(() => this.warn('CONCEPT_ASSIGNMENT_WORKER_FAILED'))
      .finally(() => {
        this.running = undefined;
      });
  }
  async stop() {
    this.stopping = true;
    await this.running;
  }
  async run(limit = 5) {
    if (!this.provider) return { processed: 0 };
    let processed = 0;
    for (let index = 0; index < Math.min(50, Math.max(1, limit)); index++) {
      if (this.stopping) break;
      // Re-select after each decision so newly captured words can overtake backfill.
      const row = (
        await this.db.query(
          `SELECT j.application_id,j.application_user_id,j.learning_item_id FROM product_gotit.concept_assignment_jobs j
      JOIN product_gotit.learning_items li ON li.application_id=j.application_id AND li.application_user_id=j.application_user_id AND li.id=j.learning_item_id
      WHERE j.status<>'completed' AND j.next_attempt_at<=now() AND (j.claim_until IS NULL OR j.claim_until<now())
      ORDER BY j.priority DESC,j.next_attempt_at,li.created_at DESC,j.learning_item_id LIMIT 1`,
          [],
        )
      ).rows[0];
      if (!row) break;
      if (await this.assign(row.application_id, row.application_user_id, row.learning_item_id))
        processed++;
    }
    return { processed };
  }
  async assign(applicationId: string, userId: string, itemId: string): Promise<boolean> {
    if (!this.provider) return false;
    const token = randomUUID();
    const job = (
      await this.db.query(
        `UPDATE product_gotit.concept_assignment_jobs SET status='processing',claim_id=$4,claim_until=now()+interval '2 minutes',attempts=attempts+1,updated_at=now()
      WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3 AND status<>'completed' AND next_attempt_at<=now()
        AND (claim_until IS NULL OR claim_until<now()) RETURNING *`,
        [applicationId, userId, itemId, token],
      )
    ).rows[0] as Job | undefined;
    if (!job) return false;
    return adminRuntimeContext.run(
      { applicationId, applicationUserId: userId, requestId: `concept-${token}`, prompts: {} },
      async () => {
        try {
          const input = await this.input(job);
          if (!input) throw new Error('CONCEPT_ITEM_INCOMPLETE');
          const saved = conceptDescriptorSchema.safeParse(job.descriptor);
          const descriptor = saved.success
            ? saved.data
            : conceptDescriptorSchema.parse(await this.provider!.describe(input));
          if (!saved.success)
            await this.db.query(
              `UPDATE product_gotit.concept_assignment_jobs SET descriptor=$5::jsonb WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3 AND claim_id=$4`,
              [...keys(job), token, JSON.stringify(descriptor)],
            );
          // Retry a changed catalog from the saved descriptor; never create against a stale candidate set.
          for (let attempt = 0; attempt < 3; attempt++) {
            const candidates = await this.candidates(this.db, input, descriptor);
            const selected = candidates.length
              ? await this.provider!.choose(input, descriptor, candidates)
              : null;
            if (selected !== null && !candidates.some((c) => c.id === selected))
              throw new Error('CONCEPT_AI_INVALID_CHOICE');
            const published = await this.publish(job, input, descriptor, candidates, selected);
            if (published === 'completed') return true;
            if (published === 'stale') return false;
          }
          throw new Error('CONCEPT_CATALOG_CHANGED');
        } catch (error) {
          const quotaExceeded =
            error instanceof AppError && error.code === 'AI_DAILY_LIMIT_REACHED';
          const code = quotaExceeded
            ? 'CONCEPT_DAILY_LIMIT_REACHED'
            : (providerFailureCode(error) ??
              (error instanceof Error && /^CONCEPT_[A-Z_]+$/u.test(error.message)
                ? error.message
                : 'CONCEPT_AI_UNAVAILABLE'));
          const permanent = [
            'authentication',
            'billing',
            'permission',
            'workspace',
            'model_access',
            'invalid_request',
          ].includes(code);
          const quotaDetails =
            quotaExceeded &&
            error.details &&
            typeof error.details === 'object' &&
            'retryAfter' in error.details
              ? Number(error.details.retryAfter)
              : 3600;
          const retry = quotaExceeded
            ? Math.min(
                86400,
                Math.max(30, Number.isFinite(quotaDetails) ? Math.ceil(quotaDetails) : 3600),
              )
            : permanent
              ? 3600
              : Math.min(3600, 30 * 2 ** Math.min(job.attempts - 1, 7));
          await this.db.query(
            `UPDATE product_gotit.concept_assignment_jobs SET status='pending',claim_id=NULL,claim_until=NULL,last_error=$5,next_attempt_at=now()+($6::int*interval '1 second'),updated_at=now()
          WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3 AND claim_id=$4`,
            [...keys(job), token, code, retry],
          );
          // One exhausted owner's historical queue must not consume the live budget,
          // churn through every row, or delay another owner's eligible work.
          if (quotaExceeded)
            await this.db.query(
              `UPDATE product_gotit.concept_assignment_jobs SET last_error=$4,next_attempt_at=GREATEST(next_attempt_at,now()+($5::int*interval '1 second'))
              WHERE application_id=$1 AND application_user_id=$2 AND (priority=0)=$3 AND status='pending' AND claim_id IS NULL`,
              [applicationId, userId, job.priority === 0, code, retry],
            );
          this.warn(code);
          return false;
        }
      },
    );
  }
  private async input(job: Job): Promise<ConceptAssignmentInput | null> {
    const row = (
      await this.db.query(
        `SELECT li.source_text,li.source_language_code,li.translation_language_code,li.part_of_speech,
      (SELECT translation_text FROM product_gotit.item_translations t WHERE t.application_id=li.application_id AND t.application_user_id=li.application_user_id AND t.learning_item_id=li.id AND t.is_current AND t.is_primary LIMIT 1) translation_text,
      (SELECT sentence_text FROM product_gotit.item_occurrences o WHERE o.application_id=li.application_id AND o.application_user_id=li.application_user_id AND o.learning_item_id=li.id AND o.learning_revision=li.learning_revision AND o.sentence_text IS NOT NULL ORDER BY o.captured_at DESC,o.id LIMIT 1) context
      FROM product_gotit.learning_items li WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND learning_revision=$4 AND deleted_at IS NULL`,
        [...keys(job), job.learning_revision],
      )
    ).rows[0];
    if (!row?.translation_text) return null;
    return {
      scope: { applicationId: job.application_id, applicationUserId: job.application_user_id },
      sourceText: row.source_text,
      sourceLanguageCode: row.source_language_code,
      translationText: row.translation_text,
      translationLanguageCode: row.translation_language_code,
      context: row.context ?? null,
      partOfSpeech: row.part_of_speech,
      workload: job.priority === 0 ? 'backfill' : 'live',
    };
  }
  private candidates(
    db: Queryable,
    input: ConceptAssignmentInput,
    descriptor: ConceptDescriptor,
  ): Promise<ConceptCandidate[]> {
    const terms = [
      {
        languageCode: input.sourceLanguageCode,
        text: conceptSearchText(input.sourceLanguageCode, input.sourceText),
      },
      {
        languageCode: input.sourceLanguageCode,
        text: conceptSearchText(input.sourceLanguageCode, descriptor.sourceLemma),
      },
      {
        languageCode: input.translationLanguageCode,
        text: conceptSearchText(input.translationLanguageCode, input.translationText),
      },
      {
        languageCode: input.translationLanguageCode,
        text: conceptSearchText(input.translationLanguageCode, descriptor.translationLemma),
      },
      ...[descriptor.lemma, ...descriptor.synonyms].map((text) => ({
        languageCode: 'en',
        text: lookupText(text),
      })),
    ];
    return db
      .query(
        `SELECT c.id,c.key,c.title,c.definition,c.revision,c.meaning_revision,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('languageCode',e.language_code,'text',e.expression) ORDER BY e.language_code,e.expression) FROM
        (SELECT language_code,substring(expression,1,120) expression FROM product_gotit.concept_expressions WHERE application_id=c.application_id AND concept_id=c.id ORDER BY (language_code='en') DESC,language_code,expression LIMIT 6) e),'[]'::jsonb) expressions
      FROM product_gotit.lexical_concepts c WHERE c.application_id=$1 AND c.status='active' AND
      (c.key=$2 OR c.canonical_lemma=ANY($3::text[]) OR EXISTS(SELECT 1 FROM product_gotit.concept_expressions e
        JOIN jsonb_to_recordset($4::jsonb) AS term("languageCode" text,text text) ON e.language_code=term."languageCode" AND e.search_text=term.text
        WHERE e.application_id=c.application_id AND e.concept_id=c.id)
        OR to_tsvector('simple',c.definition||' '||c.title)@@plainto_tsquery('simple',$5))
      ORDER BY (c.key=$2) DESC,(c.canonical_lemma=ANY($3::text[])) DESC,c.id LIMIT 40`,
        [
          input.scope.applicationId,
          descriptor.key,
          [descriptor.lemma, ...descriptor.synonyms].map(lookupText),
          JSON.stringify(terms),
          descriptor.lemma,
        ],
      )
      .then((result) => result.rows as ConceptCandidate[]);
  }
  private async publish(
    job: Job,
    input: ConceptAssignmentInput,
    descriptor: ConceptDescriptor,
    candidates: ConceptCandidate[],
    selected: string | null,
  ) {
    return withTransaction(this.db, async (tx) => {
      await tx.lock(['concept-assignment-catalog', job.application_id]);
      // Match editor lock order: concept first, then owned item, then its queue job.
      // Provider calls have already finished; no row lock spans external work.
      if (selected)
        await tx.query(
          `SELECT id FROM product_gotit.lexical_concepts WHERE application_id=$1 AND id=$2 FOR UPDATE`,
          [job.application_id, selected],
        );
      await tx.query(
        `SELECT id FROM product_gotit.learning_items WHERE application_id=$1 AND application_user_id=$2 AND id=$3 FOR UPDATE`,
        keys(job),
      );
      const current = (
        await tx.query(
          `SELECT j.* FROM product_gotit.concept_assignment_jobs j JOIN product_gotit.learning_items li
        ON li.application_id=j.application_id AND li.application_user_id=j.application_user_id AND li.id=j.learning_item_id
        WHERE j.application_id=$1 AND j.application_user_id=$2 AND j.learning_item_id=$3 AND j.claim_id=$4 AND j.generation=$5 AND j.status='processing'
          AND li.learning_revision=j.learning_revision AND li.deleted_at IS NULL FOR UPDATE OF j`,
          [...keys(job), job.claim_id, job.generation],
        )
      ).rows[0];
      if (!current) return 'stale' as const;
      if (snapshot(await this.candidates(tx, input, descriptor)) !== snapshot(candidates))
        return 'changed' as const;
      let conceptId = selected,
        meaningRevision = 1;
      if (conceptId) {
        const chosen = candidates.find((c) => c.id === conceptId)!;
        const updated = (
          await tx.query(
            `UPDATE product_gotit.lexical_concepts SET canonical_lemma=COALESCE(canonical_lemma,$4),canonical_pos=COALESCE(canonical_pos,$5),revision=revision+1,updated_at=now()
          WHERE application_id=$1 AND id=$2 AND revision=$3 AND status='active' RETURNING meaning_revision`,
            [
              job.application_id,
              conceptId,
              chosen.revision,
              lookupText(descriptor.lemma),
              descriptor.partOfSpeech,
            ],
          )
        ).rows[0];
        if (!updated) return 'changed' as const;
        meaningRevision = updated.meaning_revision;
      } else {
        let key = descriptor.key;
        if (
          (
            await tx.query(
              `SELECT 1 FROM product_gotit.lexical_concepts WHERE application_id=$1 AND key=$2`,
              [job.application_id, key],
            )
          ).rowCount
        )
          key = `${key}-${createHash('sha256')
            .update(JSON.stringify([descriptor.partOfSpeech, descriptor.definition]))
            .digest('hex')
            .slice(0, 16)}`;
        if (
          (
            await tx.query(
              `SELECT 1 FROM product_gotit.lexical_concepts WHERE application_id=$1 AND key=$2`,
              [job.application_id, key],
            )
          ).rowCount
        )
          key = `${descriptor.key}-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
        conceptId = randomUUID();
        await tx.query(
          `INSERT INTO product_gotit.lexical_concepts(application_id,id,key,title,definition,visual_description,origin,canonical_lemma,canonical_pos)
          VALUES($1,$2,$3,$4,$5,$6,'ai',$7,$8)`,
          [
            job.application_id,
            conceptId,
            key,
            descriptor.lemma,
            descriptor.definition,
            descriptor.visualDescription,
            lookupText(descriptor.lemma),
            descriptor.partOfSpeech,
          ],
        );
      }
      const forms = [
        { language: input.sourceLanguageCode, text: input.sourceText },
        { language: input.translationLanguageCode, text: input.translationText },
        { language: input.sourceLanguageCode, text: descriptor.sourceLemma },
        { language: input.translationLanguageCode, text: descriptor.translationLemma },
        { language: 'en', text: descriptor.lemma },
      ];
      for (const form of forms) {
        if ([...form.text].length > 300) continue;
        await tx.query(
          `INSERT INTO product_gotit.concept_expressions(application_id,concept_id,language_code,expression,normalized_text)
          SELECT $1,$2,$3,$4,$5 WHERE (SELECT count(*) FROM product_gotit.concept_expressions WHERE application_id=$1 AND concept_id=$2)<200
          ON CONFLICT DO NOTHING`,
          [job.application_id, conceptId, form.language, form.text, lookupText(form.text)],
        );
      }
      await tx.query(
        `INSERT INTO product_gotit.learning_item_concepts(application_id,application_user_id,learning_item_id,learning_revision,job_generation,concept_id,meaning_revision,provider_model,decision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(application_id,application_user_id,learning_item_id) DO UPDATE SET
        learning_revision=EXCLUDED.learning_revision,job_generation=EXCLUDED.job_generation,concept_id=EXCLUDED.concept_id,meaning_revision=EXCLUDED.meaning_revision,
        provider_model=EXCLUDED.provider_model,decision=EXCLUDED.decision,assigned_at=now()`,
        [
          ...keys(job),
          job.learning_revision,
          job.generation,
          conceptId,
          meaningRevision,
          this.provider!.id,
          selected ? 'matched' : 'created',
        ],
      );
      await tx.query(
        `UPDATE product_gotit.concept_assignment_jobs SET status='completed',claim_id=NULL,claim_until=NULL,last_error=NULL,updated_at=now()
        WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3 AND claim_id=$4`,
        [...keys(job), job.claim_id],
      );
      return 'completed' as const;
    });
  }
}
