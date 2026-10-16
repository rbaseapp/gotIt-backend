import { z } from 'zod';
import type { ProductAdminService, AdminActor } from './admin.service.js';
import { listSchema } from './admin.schemas.js';
import { languageSchema } from '../capture/capture.validation.js';
import { ConceptImagesService, conceptImageDto } from '../concepts/concept-images.service.js';
import { AppError } from '../../shared/errors/app-error.js';

export const wordListSchema = listSchema
  .extend({
    sort: z
      .enum([
        'id',
        'sourceText',
        'sourceLanguageCode',
        'translationLanguageCode',
        'applicationUserId',
        'createdAt',
      ])
      .default('createdAt'),
    sourceLanguageCode: languageSchema.optional(),
    translationLanguageCode: languageSchema.optional(),
    applicationUserId: z.uuid().optional(),
    state: z.enum(['all', 'active', 'deleted', 'unlinked']).default('all'),
  })
  .strict();
export const wordSectionSchema = z.enum(['translations', 'examples', 'occurrences', 'tags']);
const primary = `LEFT JOIN LATERAL(SELECT t.translation_text,t.normalized_text FROM product_gotit.item_translations t WHERE t.application_id=li.application_id AND t.application_user_id=li.application_user_id AND t.learning_item_id=li.id AND t.is_current AND t.is_primary LIMIT 1) tr ON true`;
const concepts = `LEFT JOIN LATERAL(SELECT array_agg(candidate.id ORDER BY candidate.id) ids FROM (SELECT c.id FROM product_gotit.lexical_concepts c WHERE c.application_id=li.application_id AND c.status='active'
  AND EXISTS(SELECT 1 FROM product_gotit.concept_expressions e WHERE e.application_id=c.application_id AND e.concept_id=c.id AND e.language_code=li.source_language_code AND e.normalized_text=li.normalized_source_text)
  AND EXISTS(SELECT 1 FROM product_gotit.concept_expressions e WHERE e.application_id=c.application_id AND e.concept_id=c.id AND e.language_code=li.translation_language_code AND e.normalized_text=tr.normalized_text) LIMIT 2) candidate) matches ON true`;
const fields = `li.id,li.source_text AS "sourceText",li.source_language_code AS "sourceLanguageCode",li.translation_language_code AS "translationLanguageCode",li.application_user_id AS "applicationUserId",tr.translation_text AS "primaryTranslation",li.part_of_speech AS "partOfSpeech",li.phonetic_text AS "phoneticText",li.item_type AS "itemType",li.user_status AS "userStatus",li.learning_status AS "learningStatus",li.learning_revision AS "learningRevision",li.overall_mastery_score AS "mastery",li.review_stage AS "reviewStage",li.next_review_at AS "nextReviewAt",li.created_at AS "createdAt",li.updated_at AS "updatedAt",li.deleted_at AS "deletedAt",CASE WHEN cardinality(matches.ids)=1 THEN matches.ids[1] END AS "conceptId",COALESCE(cardinality(matches.ids)>1,false) AS "conceptAmbiguous"`;

export class WordAdmin {
  constructor(private readonly owner: ProductAdminService) {}
  async list(actor: AdminActor, query: z.infer<typeof wordListSchema>, id?: string) {
    await this.owner.access(actor);
    const values: unknown[] = [actor.applicationId],
      where = ['li.application_id=$1'];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      where.push(sql.replaceAll('?', `$${values.length}`));
    };
    if (id) add('li.id=?', id);
    else {
      if (query.q)
        add(
          `(li.source_text ILIKE ? OR tr.translation_text ILIKE ?)`,
          `%${query.q.replace(/[\\%_]/g, '\\$&')}%`,
        );
      if (query.sourceLanguageCode) add('li.source_language_code=?', query.sourceLanguageCode);
      if (query.translationLanguageCode)
        add('li.translation_language_code=?', query.translationLanguageCode);
      if (query.applicationUserId) add('li.application_user_id=?', query.applicationUserId);
      if (query.state === 'active') where.push('li.deleted_at IS NULL');
      if (query.state === 'deleted') where.push('li.deleted_at IS NOT NULL');
      if (query.state === 'unlinked') where.push('COALESCE(cardinality(matches.ids),0)<>1');
    }
    const from = `FROM product_gotit.learning_items li ${primary} ${concepts} WHERE ${where.join(' AND ')}`;
    const countFrom = `FROM product_gotit.learning_items li ${primary} ${!id && query.state === 'unlinked' ? concepts : ''} WHERE ${where.join(' AND ')}`;
    const total = (await this.owner.db.query(`SELECT count(*)::int total ${countFrom}`, values))
      .rows[0].total;
    const rows = (
      await this.owner.db.query(
        `SELECT ${fields} ${from} ORDER BY "${query.sort}" ${query.order},li.id ${query.order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, id ? 1 : query.perPage, id ? 0 : (query.page - 1) * query.perPage],
      )
    ).rows;
    if (!id) return { data: rows, total };
    const row = rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Word not found');
    const scope = [actor.applicationId, row.applicationUserId, id];
    const details = (
      await this.owner.db.query(
        `SELECT li.user_priority AS "userPriority",li.manual_hard AS "manualHard",li.phonetic_scheme AS "phoneticScheme",li.mastery_source AS "masterySource",li.system_difficulty AS "systemDifficulty",li.last_practiced_at AS "lastPracticedAt",li.first_mastered_at AS "firstMasteredAt",li.last_mastered_at AS "lastMasteredAt" FROM product_gotit.learning_items li WHERE application_id=$1 AND application_user_id=$2 AND id=$3`,
        scope,
      )
    ).rows[0];
    return {
      data: {
        ...row,
        ...details,
        concept: row.conceptId
          ? (await this.owner.concepts.list(actor, listSchema.parse({}), row.conceptId)).data
          : null,
      },
    };
  }
  async image(actor: AdminActor, id: string) {
    await this.owner.access(actor);
    const row = (
      await this.owner.db.query(
        `SELECT li.*,tr.translation_text FROM product_gotit.learning_items li ${primary} WHERE li.application_id=$1 AND li.id=$2`,
        [actor.applicationId, id],
      )
    ).rows[0];
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Word not found');
    const service = new ConceptImagesService(this.owner.db);
    const concept = row.translation_text
      ? await service.resolve({
          scope: actor,
          sourceText: row.source_text,
          sourceLanguageCode: row.source_language_code,
          translationText: row.translation_text,
          translationLanguageCode: row.translation_language_code,
          context: null,
        })
      : null;
    if (concept) return { data: { id, image: await service.cached(concept, row.source_text) } };
    const image =
      row.study_image_revision === row.learning_revision && row.study_image_data
        ? conceptImageDto(
            {
              data: row.study_image_data,
              contentType: row.study_image_content_type,
              kind: row.study_image_kind,
              provider: row.study_image_provider,
              sourceUrl: row.study_image_source_url,
              creator: row.study_image_creator,
            },
            row.source_text,
          )
        : null;
    return { data: { id, image } };
  }
  async section(
    actor: AdminActor,
    id: string,
    section: z.infer<typeof wordSectionSchema>,
    query: z.infer<typeof listSchema>,
  ) {
    await this.owner.access(actor);
    const item = (
      await this.owner.db.query(
        `SELECT application_user_id FROM product_gotit.learning_items WHERE application_id=$1 AND id=$2`,
        [actor.applicationId, id],
      )
    ).rows[0];
    if (!item) throw new AppError(404, 'NOT_FOUND', 'Word not found');
    const selects = {
      translations: `SELECT t.id,t.translation_text AS text,t.is_primary AS "isPrimary",t.is_current AS "isCurrent",t.source_kind AS "sourceKind",t.provider_name AS "providerName",t.provider_model AS "providerModel",t.is_user_edited AS "isUserEdited",t.created_at AS "createdAt" FROM product_gotit.item_translations t`,
      examples: `SELECT t.id,t.example_text AS text,t.source_kind AS "sourceKind",t.learning_revision AS "learningRevision",t.created_at AS "createdAt" FROM product_gotit.item_examples t`,
      occurrences: `SELECT t.id,t.source_type AS "sourceType",t.selected_text AS "selectedText",t.sentence_text AS "sentenceText",t.paragraph_text AS "paragraphText",t.page_title AS "pageTitle",t.page_url AS "pageUrl",t.captured_at AS "capturedAt" FROM product_gotit.item_occurrences t`,
      tags: `SELECT t.tag_id AS id,tag.name FROM product_gotit.learning_item_tags t JOIN product_gotit.tags tag ON tag.application_id=t.application_id AND tag.application_user_id=t.application_user_id AND tag.id=t.tag_id`,
    };
    const sql = `${selects[section]} WHERE t.application_id=$1 AND t.application_user_id=$2 AND t.learning_item_id=$3`;
    const keys = [actor.applicationId, item.application_user_id, id];
    const total = (
      await this.owner.db.query(`SELECT count(*)::int total FROM (${sql}) result`, keys)
    ).rows[0].total;
    const data = (
      await this.owner.db.query(`${sql} ORDER BY id LIMIT $4 OFFSET $5`, [
        ...keys,
        query.perPage,
        (query.page - 1) * query.perPage,
      ])
    ).rows;
    return { data, total };
  }
}
