import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ProductAdminService, AdminActor } from './admin.service.js';
import { commandSchema } from './admin.schemas.js';
import { AppError } from '../../shared/errors/app-error.js';
import { withTransaction } from '../../shared/database/transaction.js';
import { conceptImageDto } from '../concepts/concept-images.service.js';
import type { StudyImageProvider } from '../practice/study-image.provider.js';

export const regenerateConceptSchema = commandSchema
  .extend({
    expectedRevision: z.number().int().nonnegative(),
    source: z.enum(['stock', 'ai']),
    prompt: z.string().trim().max(500).default(''),
    searchQuery: z
      .string()
      .trim()
      .max(100)
      .regex(/^[a-zA-Z0-9 ,'-]*$/)
      .default(''),
  })
  .strict();

const conflict = () =>
  new AppError(409, 'CONFLICT', 'The meaning changed. Reload before continuing.');
const unavailable = () =>
  new AppError(
    503,
    'CONCEPT_IMAGE_UNAVAILABLE',
    'The image provider is unavailable or busy. Retry the same request.',
  );

/** Reserve an unused asset revision; keep serving the current image until publication. */
export async function regenerateConcept(
  owner: ProductAdminService,
  providers: Partial<Record<'stock' | 'ai', StudyImageProvider>>,
  actor: AdminActor,
  id: string,
  input: z.infer<typeof regenerateConceptSchema> & { stockSelection?: string },
  wordGuard?: { id: string; revision: number },
) {
  await owner.access(actor, 'content.write');
  const provider = providers[input.source];
  if (!provider) throw unavailable();
  const reservation = await owner.command(
    actor,
    'content.write',
    'concept.image.replace',
    'concepts',
    id,
    input,
    async (tx) => {
      if (wordGuard) await checkWord(tx, actor.applicationId, wordGuard);
      const row = (
        await tx.query(
          `SELECT * FROM product_gotit.lexical_concepts WHERE application_id=$1 AND id=$2 FOR UPDATE`,
          [actor.applicationId, id],
        )
      ).rows[0];
      if (!row) throw new AppError(404, 'NOT_FOUND', 'Concept not found');
      if (row.status !== 'active' || row.revision !== input.expectedRevision) throw conflict();
      if (
        input.source === 'stock' &&
        !input.stockSelection &&
        !(input.searchQuery || row.stock_search_query)
      )
        throw new AppError(400, 'VALIDATION_ERROR', 'An English stock search query is required');
      const revision = (
        await tx.query(
          `SELECT GREATEST($3::int,COALESCE(max(image_revision),0))+1 AS revision FROM product_gotit.concept_image_assets WHERE application_id=$1 AND concept_id=$2`,
          [actor.applicationId, id, row.image_revision],
        )
      ).rows[0]!.revision;
      await tx.query(
        `INSERT INTO product_gotit.concept_image_assets(application_id,concept_id,image_revision,claim_id,claim_until) VALUES($1,$2,$3,$4,'epoch')`,
        [actor.applicationId, id, revision, randomUUID()],
      );
      return { id, revision: row.revision + 1, imageRevision: revision };
    },
  );
  const imageRevision = Number(reservation.data!.imageRevision);
  const keys = [actor.applicationId, id, imageRevision];
  const complete = async () =>
    (
      await owner.db.query(
        `SELECT concept_id FROM product_gotit.concept_image_assets WHERE application_id=$1 AND concept_id=$2 AND image_revision=$3 AND image_data IS NOT NULL`,
        keys,
      )
    ).rowCount;
  if (await complete()) return reservation;
  const token = randomUUID();
  const row = await withTransaction(owner.db, async (tx) => {
    if (wordGuard) await checkWord(tx, actor.applicationId, wordGuard);
    // Serialize claims across different operation UUIDs for this meaning.
    await tx.lock(['concept-regeneration', actor.applicationId, id]);
    const current = (
      await tx.query(
        `SELECT c.*,a.image_source_url FROM product_gotit.lexical_concepts c LEFT JOIN product_gotit.concept_image_assets a ON a.application_id=c.application_id AND a.concept_id=c.id AND a.image_revision=c.image_revision WHERE c.application_id=$1 AND c.id=$2`,
        keys.slice(0, 2),
      )
    ).rows[0];
    if (!current || current.status !== 'active' || current.revision !== input.expectedRevision)
      throw conflict();
    const claimed = await tx.query(
      `UPDATE product_gotit.concept_image_assets a SET claim_id=$4,claim_until=now()+interval '5 minutes' WHERE application_id=$1 AND concept_id=$2 AND image_revision=$3 AND image_data IS NULL AND claim_until<now() AND NOT EXISTS(SELECT 1 FROM product_gotit.concept_image_assets busy WHERE busy.application_id=$1 AND busy.concept_id=$2 AND busy.image_data IS NULL AND busy.claim_until>now()) RETURNING concept_id`,
      [...keys, token],
    );
    if (!claimed.rowCount) throw unavailable();
    return current;
  });
  try {
    await owner.profilesForLearner(actor);
    const forms = (
      await owner.db.query(
        `SELECT language_code,expression FROM product_gotit.concept_expressions WHERE application_id=$1 AND concept_id=$2 ORDER BY (language_code='en') DESC,language_code,expression LIMIT 2`,
        keys.slice(0, 2),
      )
    ).rows;
    if (!forms.length) throw conflict();
    const second =
      forms.find((form) => form.language_code !== forms[0].language_code) ?? forms[1] ?? forms[0];
    const query = input.searchQuery || row.stock_search_query;
    const image = await provider.generate({
      scope: actor,
      sourceText: forms[0].expression,
      sourceLanguageCode: forms[0].language_code,
      translationText: second.expression,
      translationLanguageCode: second.language_code,
      context: null,
      excludeSourceUrls: row.image_source_url ? [row.image_source_url] : [],
      ...(input.stockSelection ? { stockSelection: input.stockSelection } : {}),
      visual: {
        senseKey: `concept.${id}.${imageRevision}`,
        subject: row.title,
        visualDescription: `${row.definition}. ${input.prompt || row.visual_description}`.slice(
          0,
          1600,
        ),
        searchQueries: input.source === 'stock' ? [query] : [],
        includeTags: input.source === 'stock' ? [query.replace(/\bisolated\b/giu, '').trim()] : [],
        excludeTags: ['text', 'logos', 'typography'],
      },
    });
    if (
      !image ||
      !conceptImageDto(image, row.title) ||
      image.kind !== (input.source === 'stock' ? 'stock' : 'generated') ||
      (!input.stockSelection && image.sourceUrl && image.sourceUrl === row.image_source_url)
    )
      throw unavailable();
    await withTransaction(owner.db, async (tx) => {
      if (wordGuard) await checkWord(tx, actor.applicationId, wordGuard);
      const current = (
        await tx.query(
          `SELECT revision,status FROM product_gotit.lexical_concepts WHERE application_id=$1 AND id=$2 FOR UPDATE`,
          keys.slice(0, 2),
        )
      ).rows[0];
      if (current?.revision !== input.expectedRevision || current.status !== 'active')
        throw conflict();
      const stored = await tx.query(
        `UPDATE product_gotit.concept_image_assets SET image_data=$5,image_content_type=$6,image_kind=$7,image_provider=$8,image_model=$9,image_source_url=$10,image_creator=$11 WHERE application_id=$1 AND concept_id=$2 AND image_revision=$3 AND claim_id=$4 AND image_data IS NULL RETURNING concept_id`,
        [
          ...keys,
          token,
          image.data,
          image.contentType,
          image.kind,
          image.provider,
          provider.id,
          image.sourceUrl,
          image.creator,
        ],
      );
      if (!stored.rowCount) throw conflict();
      await tx.query(
        `UPDATE product_gotit.lexical_concepts SET image_revision=$3,revision=revision+1,updated_at=now() WHERE application_id=$1 AND id=$2`,
        keys,
      );
      await tx.query(
        `INSERT INTO product_gotit.admin_audit_events(application_id,actor_id,action,resource,target_id,reason,metadata) VALUES($1,$2,'concept.image.published','concepts',$3,$4,$5::jsonb)`,
        [
          actor.applicationId,
          actor.applicationUserId,
          id,
          input.reason,
          JSON.stringify({
            operationId: input.operationId,
            imageRevision,
            source: input.source,
            provider: image.provider,
          }),
        ],
      );
    });
    return reservation;
  } finally {
    await owner.db.query(
      `UPDATE product_gotit.concept_image_assets SET claim_until='epoch' WHERE application_id=$1 AND concept_id=$2 AND image_revision=$3 AND claim_id=$4 AND image_data IS NULL`,
      [...keys, token],
    );
  }
}

async function checkWord(
  tx: import('../../shared/database/transaction.js').DatabaseTransaction,
  applicationId: string,
  word: { id: string; revision: number },
) {
  const row = (
    await tx.query(
      `SELECT learning_revision FROM product_gotit.learning_items WHERE application_id=$1 AND id=$2 FOR UPDATE`,
      [applicationId, word.id],
    )
  ).rows[0];
  if (row?.learning_revision !== word.revision) throw conflict();
}
