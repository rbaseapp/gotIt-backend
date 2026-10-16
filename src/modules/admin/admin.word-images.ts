import { createHash } from 'node:crypto';
import { z } from 'zod';
import { commandSchema } from './admin.schemas.js';
import type { AdminActor, ProductAdminService } from './admin.service.js';
import type { StudyImageProvider } from '../practice/study-image.provider.js';
import { ensureWordImageConcept } from '../concepts/automatic-word-images.js';
import { regenerateConcept } from './admin.concept-regeneration.js';
import { AppError } from '../../shared/errors/app-error.js';

export const stockSearchSchema = z
  .object({
    q: z.string().trim().min(1).max(100),
    page: z.coerce.number().int().min(1).max(50).default(1),
  })
  .strict();
export const wordImageSchema = commandSchema
  .extend({
    expectedRevision: z.number().int().positive(),
    expectedConceptRevision: z.number().int().nonnegative().nullable().default(null),
    source: z.enum(['stock', 'ai']),
    prompt: z.string().trim().max(500).default(''),
    searchQuery: z.string().trim().max(100).default(''),
    stockSelection: z.string().min(1).max(6000).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.source === 'stock' && !value.stockSelection)
      ctx.addIssue({
        code: 'custom',
        path: ['stockSelection'],
        message: 'Select a Pixabay search result',
      });
    if (value.source === 'ai' && value.stockSelection)
      ctx.addIssue({
        code: 'custom',
        path: ['stockSelection'],
        message: 'Stock selection is not an AI input',
      });
  });

export class WordImageAdmin {
  constructor(
    private readonly owner: ProductAdminService,
    private readonly providers: Partial<Record<'stock' | 'ai', StudyImageProvider>>,
  ) {}
  get sources() {
    return { stock: !!this.providers.stock?.candidates, ai: !!this.providers.ai };
  }
  async search(actor: AdminActor, id: string, input: z.infer<typeof stockSearchSchema>) {
    await this.owner.access(actor);
    const exists = await this.owner.db.query(
      `SELECT id FROM product_gotit.learning_items WHERE application_id=$1 AND id=$2`,
      [actor.applicationId, id],
    );
    if (!exists.rowCount) throw new AppError(404, 'NOT_FOUND', 'Word not found');
    const provider = this.providers.stock;
    if (!provider?.candidates)
      throw new AppError(503, 'CONCEPT_IMAGE_UNAVAILABLE', 'Pixabay search is unavailable');
    return provider.candidates(input.q, actor.applicationId, input.page);
  }
  async replace(actor: AdminActor, id: string, input: z.infer<typeof wordImageSchema>) {
    await this.owner.access(actor, 'content.write');
    if (!this.providers[input.source])
      throw new AppError(503, 'CONCEPT_IMAGE_UNAVAILABLE', 'Image provider is unavailable');
    const prepared = await this.owner.command(
      actor,
      'content.write',
      'word.image.request',
      'words',
      id,
      input,
      async (tx) => {
        const row = (
          await tx.query(
            `SELECT li.*,tr.translation_text FROM product_gotit.learning_items li LEFT JOIN LATERAL(SELECT translation_text FROM product_gotit.item_translations t WHERE t.application_id=li.application_id AND t.application_user_id=li.application_user_id AND t.learning_item_id=li.id AND t.is_primary AND t.is_current LIMIT 1) tr ON true WHERE li.application_id=$1 AND li.id=$2 FOR UPDATE OF li`,
            [actor.applicationId, id],
          )
        ).rows[0];
        if (!row) throw new AppError(404, 'NOT_FOUND', 'Word not found');
        if (row.learning_revision !== input.expectedRevision)
          throw new AppError(409, 'CONFLICT', 'The word changed. Reload before continuing.');
        const concept = await ensureWordImageConcept(tx, actor.applicationId, row);
        if (
          input.expectedConceptRevision !== null &&
          concept.revision !== input.expectedConceptRevision
        )
          throw new AppError(
            409,
            'CONFLICT',
            'The shared image changed. Reload before continuing.',
          );
        return { id, conceptId: concept.id, conceptRevision: concept.revision };
      },
    );
    // A stable child UUID allows a prepared request to resume without repeating paid work.
    const hex = createHash('sha256')
      .update(input.operationId + ':word-image')
      .digest('hex');
    const operationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    const result = await regenerateConcept(
      this.owner,
      this.providers,
      actor,
      String(prepared.data.conceptId),
      {
        operationId,
        reason: input.reason,
        expectedRevision: Number(prepared.data.conceptRevision),
        source: input.source,
        prompt: input.prompt,
        searchQuery: input.searchQuery,
        stockSelection: input.stockSelection,
      },
      { id, revision: input.expectedRevision },
    );
    return {
      data: {
        id,
        conceptId: result.data.id,
        conceptRevision: result.data.revision,
        imageRevision: result.data.imageRevision,
      },
    };
  }
}
