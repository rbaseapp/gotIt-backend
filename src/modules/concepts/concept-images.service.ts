import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { lookupText } from '../capture/capture.validation.js';
import type {
  GeneratedStudyImage,
  StudyImageInput,
  StudyImageProvider,
} from '../practice/study-image.provider.js';

export type ResolvedConcept = {
  id: string;
  application_id: string;
  key: string;
  title: string;
  definition: string;
  visual_description: string;
  stock_search_query: string;
  image_revision: number;
};

export function conceptImageDto(image: GeneratedStudyImage, alt: string) {
  if (
    !Buffer.isBuffer(image.data) ||
    image.data.length < 1 ||
    image.data.length > 3_000_000 ||
    !['image/png', 'image/jpeg', 'image/webp'].includes(image.contentType) ||
    !['stock', 'generated'].includes(image.kind) ||
    !image.provider ||
    image.provider.length > 100 ||
    (image.kind === 'stock' && !/^https:\/\//iu.test(image.sourceUrl ?? ''))
  )
    return null;
  return {
    url: `data:${image.contentType};base64,${image.data.toString('base64')}`,
    alt,
    generated: image.kind === 'generated',
    provider: image.provider,
    sourceUrl: image.sourceUrl,
    creator: image.creator,
  };
}

/** Staff-approved senses only. Never infer equivalence from spelling or an AI sense key. */
export class ConceptImagesService {
  constructor(
    private readonly db: Pool,
    private readonly provider?: StudyImageProvider,
    private readonly automaticAssignments = false,
  ) {}
  async pending(input:StudyImageInput) {
    if(!this.automaticAssignments||!input.scope||!input.learningItemId)return false;
    return Boolean((await this.db.query(`SELECT 1 FROM product_gotit.concept_assignment_jobs WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3 AND status<>'completed'`,
      [input.scope.applicationId,input.scope.applicationUserId,input.learningItemId])).rowCount);
  }
  async resolve(input: StudyImageInput): Promise<ResolvedConcept | null> {
    if (!input.scope) return null;
    if(input.learningItemId){
      const linked=(await this.db.query(`SELECT c.* FROM product_gotit.learning_item_concepts b
        JOIN product_gotit.lexical_concepts c ON c.application_id=b.application_id AND c.id=b.concept_id AND c.meaning_revision=b.meaning_revision AND c.status='active'
        JOIN product_gotit.learning_items li ON li.application_id=b.application_id AND li.application_user_id=b.application_user_id AND li.id=b.learning_item_id AND li.learning_revision=b.learning_revision AND li.deleted_at IS NULL
        JOIN product_gotit.concept_assignment_jobs j ON j.application_id=b.application_id AND j.application_user_id=b.application_user_id AND j.learning_item_id=b.learning_item_id AND j.generation=b.job_generation AND j.status='completed'
        WHERE b.application_id=$1 AND b.application_user_id=$2 AND b.learning_item_id=$3`,[input.scope.applicationId,input.scope.applicationUserId,input.learningItemId])).rows[0];
      if(linked)return linked as ResolvedConcept;
    }
    const rows = (
      await this.db.query(
        `SELECT c.* FROM product_gotit.lexical_concepts c
      WHERE c.application_id=$1 AND c.status='active'
      AND EXISTS(SELECT 1 FROM product_gotit.concept_expressions e WHERE e.application_id=c.application_id AND e.concept_id=c.id AND e.language_code=$2 AND e.normalized_text=$3)
      AND EXISTS(SELECT 1 FROM product_gotit.concept_expressions e WHERE e.application_id=c.application_id AND e.concept_id=c.id AND e.language_code=$4 AND e.normalized_text=$5)
      LIMIT 2`,
        [
          input.scope.applicationId,
          input.sourceLanguageCode,
          lookupText(input.sourceText),
          input.translationLanguageCode,
          lookupText(input.translationText),
        ],
      )
    ).rows;
    return rows.length === 1 ? (rows[0] as ResolvedConcept) : null;
  }
  async cached(concept: ResolvedConcept, alt: string) {
    const row = (
      await this.db.query(
        `SELECT a.* FROM product_gotit.concept_image_assets a
      JOIN product_gotit.lexical_concepts c ON c.application_id=a.application_id AND c.id=a.concept_id AND c.image_revision=a.image_revision
      WHERE a.application_id=$1 AND a.concept_id=$2 AND a.image_revision=$3 AND a.image_data IS NOT NULL AND c.status='active'`,
        [concept.application_id, concept.id, concept.image_revision],
      )
    ).rows[0];
    return row
      ? conceptImageDto(
          {
            data: row.image_data,
            contentType: row.image_content_type,
            kind: row.image_kind,
            provider: row.image_provider,
            sourceUrl: row.image_source_url,
            creator: row.image_creator,
          },
          alt,
        )
      : null;
  }
  async image(concept: ResolvedConcept, input: StudyImageInput, generate: boolean) {
    const cached = await this.cached(concept, input.sourceText);
    if (cached || !generate || !this.provider) return cached;
    const token = randomUUID();
    const keys = [concept.application_id, concept.id, concept.image_revision, token];
    // A persistent claim prevents duplicate paid work across processes and language pairs.
    // Provider requests run outside transactions. A crashed worker's claim expires.
    const claim = await this.db.query(
      `INSERT INTO product_gotit.concept_image_assets
      (application_id,concept_id,image_revision,claim_id,claim_until)
      SELECT $1,$2,$3,$4,now()+interval '5 minutes'
      WHERE EXISTS(SELECT 1 FROM product_gotit.lexical_concepts c WHERE c.application_id=$1 AND c.id=$2 AND c.image_revision=$3 AND c.status='active')
      ON CONFLICT(application_id,concept_id,image_revision) DO UPDATE SET claim_id=EXCLUDED.claim_id,claim_until=EXCLUDED.claim_until
      WHERE concept_image_assets.image_data IS NULL AND concept_image_assets.claim_until<now()
      RETURNING claim_id`,
      keys,
    );
    if (!claim.rowCount) return this.cached(concept, input.sourceText);
    try {
      const image = await this.provider.generate({
        ...input,
        context: null,
        visual: {
          senseKey: `concept.${concept.id}.${concept.image_revision}`,
          subject: concept.title,
          visualDescription: concept.visual_description,
          searchQueries: concept.stock_search_query ? [concept.stock_search_query] : [],
          includeTags: concept.stock_search_query
            ? [concept.stock_search_query.replace(/\bisolated\b/giu, '').trim()]
            : [],
          excludeTags: ['text', 'logos', 'typography'],
        },
      });
      if (!image || !conceptImageDto(image, input.sourceText)) return null;
      const stored = await this.db.query(
        `UPDATE product_gotit.concept_image_assets a SET
        image_data=$5,image_content_type=$6,image_kind=$7,image_provider=$8,image_model=$9,image_source_url=$10,image_creator=$11
        WHERE a.application_id=$1 AND a.concept_id=$2 AND a.image_revision=$3 AND a.claim_id=$4
        AND EXISTS(SELECT 1 FROM product_gotit.lexical_concepts c WHERE c.application_id=a.application_id AND c.id=a.concept_id AND c.image_revision=a.image_revision AND c.status='active') RETURNING concept_id`,
        [
          ...keys,
          image.data,
          image.contentType,
          image.kind,
          image.provider,
          this.provider.id,
          image.sourceUrl,
          image.creator,
        ],
      );
      return stored.rowCount ? conceptImageDto(image, input.sourceText) : null;
    } finally {
      await this.db.query(
        `DELETE FROM product_gotit.concept_image_assets WHERE application_id=$1 AND concept_id=$2 AND image_revision=$3 AND claim_id=$4 AND image_data IS NULL`,
        keys,
      );
    }
  }
}
