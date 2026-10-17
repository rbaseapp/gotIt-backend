import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { ProductAdminService, AdminActor } from './admin.service.js';
import type { listSchema, generateSchema } from './admin.schemas.js';
import type { conceptSaveSchema } from '../concepts/concepts.schema.js';
import { ConceptImagesService, type ResolvedConcept } from '../concepts/concept-images.service.js';
import type { StudyImageProvider } from '../practice/study-image.provider.js';
import { lookupText } from '../capture/capture.validation.js';
import { AppError } from '../../shared/errors/app-error.js';
import { regenerateConcept, type regenerateConceptSchema } from './admin.concept-regeneration.js';

const conflict = () =>
  new AppError(409, 'CONFLICT', 'Saved work changed. Reload before continuing.');
const columns = `c.id,c.key,c.title,c.definition,c.origin,c.meaning_revision AS "meaningRevision",c.visual_description AS "visualDescription",c.stock_search_query AS "stockSearchQuery",c.status,c.revision,c.image_revision AS "imageRevision",c.created_at AS "createdAt",c.updated_at AS "updatedAt",
  (SELECT count(*)::int FROM product_gotit.concept_expressions e WHERE e.application_id=c.application_id AND e.concept_id=c.id) AS "expressionCount",
  EXISTS(SELECT 1 FROM product_gotit.concept_image_assets a WHERE a.application_id=c.application_id AND a.concept_id=c.id AND a.image_revision=c.image_revision AND a.image_data IS NOT NULL) AS "hasImage"`;

export class ConceptAdmin {
  constructor(
    private readonly owner: ProductAdminService,
    private readonly images?: StudyImageProvider,
    private readonly replacementProviders: Partial<Record<'stock' | 'ai', StudyImageProvider>> = {},
  ) {}
  regenerate(actor: AdminActor, id: string, input: z.infer<typeof regenerateConceptSchema>) {
    return regenerateConcept(this.owner, this.replacementProviders, actor, id, input);
  }
  async list(actor: AdminActor, query: z.infer<typeof listSchema>, id?: string) {
    await this.owner.access(actor);
    const values: unknown[] = [actor.applicationId];
    let where = 'c.application_id=$1';
    if (id) {
      values.push(id);
      where += ' AND c.id=$2';
    } else if (query.q) {
      values.push(`%${query.q.replace(/[\\%_]/g, '\\$&')}%`);
      where += ` AND (c.title ILIKE $2 OR c.key ILIKE $2 OR c.definition ILIKE $2 OR EXISTS(SELECT 1 FROM product_gotit.concept_expressions e WHERE e.application_id=c.application_id AND e.concept_id=c.id AND e.expression ILIKE $2))`;
    }
    if (!['id', 'key', 'title', 'status', 'createdAt'].includes(query.sort))
      throw new AppError(400, 'VALIDATION_ERROR', 'Unsupported sort field');
    const count = (
      await this.owner.db.query(
        `SELECT count(*)::int AS total FROM product_gotit.lexical_concepts c WHERE ${where}`,
        values,
      )
    ).rows[0].total;
    const rows = (
      await this.owner.db.query(
        `SELECT ${columns} FROM product_gotit.lexical_concepts c WHERE ${where}
      ORDER BY "${query.sort}" ${query.order},c.id ${query.order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        [...values, id ? 1 : query.perPage, id ? 0 : (query.page - 1) * query.perPage],
      )
    ).rows;
    if (!id) return { data: rows, total: count };
    if (!rows[0]) throw new AppError(404, 'NOT_FOUND', 'Concept not found');
    const expressions = (
      await this.owner.db.query(
        `SELECT language_code AS "languageCode",expression AS text FROM product_gotit.concept_expressions WHERE application_id=$1 AND concept_id=$2 ORDER BY language_code,expression`,
        [actor.applicationId, id],
      )
    ).rows;
    const row = rows[0];
    const concept = {
      ...row,
      application_id: actor.applicationId,
      image_revision: row.imageRevision,
    } as ResolvedConcept;
    return {
      data: {
        ...row,
        expressions,
        imageSources: {
          stock: !!this.replacementProviders.stock,
          ai: !!this.replacementProviders.ai,
        },
        image: await new ConceptImagesService(this.owner.db).cached(concept, row.title),
      },
    };
  }
  save(actor: AdminActor, id: string | null, input: z.infer<typeof conceptSaveSchema>) {
    return this.owner.command(
      actor,
      'content.write',
      'concept.save',
      'concepts',
      id,
      input,
      async (tx) => {
        const doc = input.document;
        await tx.lock(['concept-key', actor.applicationId, doc.key]);
        const duplicate = (
          await tx.query(
            `SELECT id FROM product_gotit.lexical_concepts WHERE application_id=$1 AND key=$2 AND ($3::uuid IS NULL OR id<>$3)`,
            [actor.applicationId, doc.key, id],
          )
        ).rows[0];
        if (duplicate)
          throw new AppError(409, 'CONCEPT_KEY_EXISTS', 'This concept key already exists');
        const old = id
          ? (
              await tx.query(
                `SELECT * FROM product_gotit.lexical_concepts WHERE application_id=$1 AND id=$2 FOR UPDATE`,
                [actor.applicationId, id],
              )
            ).rows[0]
          : null;
        if (id && !old) throw new AppError(404, 'NOT_FOUND', 'Concept not found');
        if (
          (id && old?.revision !== input.expectedRevision) ||
          (!id && input.expectedRevision !== null)
        )
          throw conflict();
        if (old && old.key !== doc.key)
          throw new AppError(400, 'VALIDATION_ERROR', 'Concept keys are immutable');
        const conceptId = id ?? randomUUID();
        const imageChanged =
          old &&
          (old.definition !== doc.definition ||
            old.visual_description !== doc.visualDescription ||
            old.stock_search_query !== doc.stockSearchQuery ||
            input.resetImage);
        const revision = old ? old.revision + 1 : 0;
        const imageRevision =
          old && imageChanged
            ? (
                await tx.query(
                  `SELECT GREATEST($3::int,COALESCE(max(image_revision),0))+1 AS revision FROM product_gotit.concept_image_assets WHERE application_id=$1 AND concept_id=$2`,
                  [actor.applicationId, conceptId, old.image_revision],
                )
              ).rows[0]!.revision
            : old
              ? old.image_revision
              : 1;
        if (old)
          await tx.query(
            `UPDATE product_gotit.lexical_concepts SET title=$3,definition=$4,visual_description=$5,status=$6,revision=$7,image_revision=$8,stock_search_query=$9,automatic_identity=NULL,updated_at=now() WHERE application_id=$1 AND id=$2`,
            [
              actor.applicationId,
              conceptId,
              doc.title,
              doc.definition,
              doc.visualDescription,
              doc.status,
              revision,
              imageRevision,
              doc.stockSearchQuery,
            ],
          );
        else
          await tx.query(
            `INSERT INTO product_gotit.lexical_concepts(application_id,id,key,title,definition,visual_description,status,stock_search_query) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              actor.applicationId,
              conceptId,
              doc.key,
              doc.title,
              doc.definition,
              doc.visualDescription,
              doc.status,
              doc.stockSearchQuery,
            ],
          );
        await tx.query(
          `DELETE FROM product_gotit.concept_expressions WHERE application_id=$1 AND concept_id=$2`,
          [actor.applicationId, conceptId],
        );
        for (const e of doc.expressions)
          await tx.query(
            `INSERT INTO product_gotit.concept_expressions(application_id,concept_id,language_code,expression,normalized_text) VALUES($1,$2,$3,$4,$5)`,
            [actor.applicationId, conceptId, e.languageCode, e.text, lookupText(e.text)],
          );
        return { id: conceptId, ...doc, revision, imageRevision };
      },
    );
  }
  async generate(actor: AdminActor, id: string, input: z.infer<typeof generateSchema>) {
    // Record the authorized request before external work. Replay ensures the same
    // operation cannot be repurposed, and the concept cache makes ensure-image idempotent.
    const result = await this.owner.command(
      actor,
      'content.write',
      'concept.image.request',
      'concepts',
      id,
      input,
      async (tx) => {
        const row = (
          await tx.query(
            `SELECT * FROM product_gotit.lexical_concepts WHERE application_id=$1 AND id=$2 FOR SHARE`,
            [actor.applicationId, id],
          )
        ).rows[0];
        if (!row) throw new AppError(404, 'NOT_FOUND', 'Concept not found');
        if (row.revision !== input.expectedRevision || row.status !== 'active') throw conflict();
        return { id, revision: row.revision, imageRevision: row.image_revision };
      },
    );
    const row = (
      await this.owner.db.query(
        `SELECT * FROM product_gotit.lexical_concepts WHERE application_id=$1 AND id=$2 AND revision=$3 AND status='active'`,
        [actor.applicationId, id, input.expectedRevision],
      )
    ).rows[0] as ResolvedConcept | undefined;
    if (!row) throw conflict();
    const forms = (
      await this.owner.db.query(
        `SELECT language_code,expression FROM product_gotit.concept_expressions WHERE application_id=$1 AND concept_id=$2 ORDER BY (language_code='en') DESC,language_code,expression LIMIT 2`,
        [actor.applicationId, id],
      )
    ).rows;
    if (forms.length < 2) throw conflict();
    await this.owner.profilesForLearner(actor);
    const image = await new ConceptImagesService(this.owner.db, this.images).image(
      row,
      {
        scope: actor,
        sourceText: forms[0].expression,
        sourceLanguageCode: forms[0].language_code,
        translationText: forms[1].expression,
        translationLanguageCode: forms[1].language_code,
        context: null,
      },
      true,
    );
    if (!image)
      throw new AppError(
        503,
        'CONCEPT_IMAGE_UNAVAILABLE',
        'Image is being generated or the provider is unavailable. Retry the same request.',
      );
    return result;
  }
}
