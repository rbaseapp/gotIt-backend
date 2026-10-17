import { randomUUID } from 'node:crypto';
import type { DatabaseTransaction } from '../../shared/database/transaction.js';
import { lookupText } from '../capture/capture.validation.js';
import { AppError } from '../../shared/errors/app-error.js';

/** Reviewed meanings (including a unique new-language link), then exact automatic pairs. */
export async function ensureWordImageConcept(
  tx: DatabaseTransaction,
  applicationId: string,
  word: Record<string, any>,
) {
  const forms = [[word.source_language_code, lookupText(word.source_text)]];
  if (word.translation_text)
    forms.push([word.translation_language_code, lookupText(word.translation_text)]);
  const identity = JSON.stringify(
    [...new Map(forms.map((f) => [JSON.stringify(f), f])).values()].sort((a, b) =>
      Buffer.compare(Buffer.from(JSON.stringify(a)), Buffer.from(JSON.stringify(b))),
    ),
  );
  await tx.lock(['automatic-word-image', applicationId, identity]);
  let concept = (
    await tx.query(
      `SELECT c.* FROM product_gotit.learning_item_concepts b
      JOIN product_gotit.lexical_concepts c ON c.application_id=b.application_id AND c.id=b.concept_id AND c.meaning_revision=b.meaning_revision AND c.status='active'
      JOIN product_gotit.concept_assignment_jobs j ON j.application_id=b.application_id AND j.application_user_id=b.application_user_id AND j.learning_item_id=b.learning_item_id AND j.generation=b.job_generation AND j.status='completed'
      WHERE b.application_id=$1 AND b.application_user_id=$2 AND b.learning_item_id=$3 AND b.learning_revision=$4`,
      [applicationId, word.application_user_id, word.id, word.learning_revision],
    )
  ).rows[0];
  concept ??= (
    await tx.query(
      `SELECT c.* FROM product_gotit.resolve_image_concept($1,$2,$3,$4,$5) resolved
      JOIN product_gotit.lexical_concepts c ON c.application_id=$1 AND c.id=resolved.concept_id`,
      [applicationId, forms[0]![0], forms[0]![1], forms[1]?.[0], forms[1]?.[1]],
    )
  ).rows[0];
  if (!concept) {
    const title = `${word.source_text}${word.translation_text ? ' / ' + word.translation_text : ''}`;
    const query =
      word.source_language_code === 'en'
        ? word.source_text
        : word.translation_language_code === 'en'
          ? (word.translation_text ?? '')
          : '';
    concept = (
      await tx.query(
        `INSERT INTO product_gotit.lexical_concepts(application_id,key,title,definition,visual_description,stock_search_query,automatic_identity)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(application_id,automatic_identity) WHERE automatic_identity IS NOT NULL DO UPDATE SET automatic_identity=EXCLUDED.automatic_identity RETURNING *`,
        [
          applicationId,
          `auto-${randomUUID()}`,
          title.slice(0, 200),
          title.slice(0, 1000),
          `One clear depiction of ${title}, plain background, no text or logos.`.slice(0, 500),
          /^[a-zA-Z0-9 ,'-]*$/.test(query) ? query.slice(0, 100) : '',
          identity,
        ],
      )
    ).rows[0]!;
    if (concept.status !== 'active')
      throw new AppError(409, 'CONFLICT', 'This image meaning is disabled');
    for (const [lang, text] of forms)
      await tx.query(
        `INSERT INTO product_gotit.concept_expressions(application_id,concept_id,language_code,expression,normalized_text) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [
          applicationId,
          concept.id,
          lang,
          (lang === word.source_language_code && text === lookupText(word.source_text)
            ? word.source_text
            : word.translation_text
          ).slice(0, 300),
          text,
        ],
      );
  }
  // Linking a future word must keep its last good picture until replacement succeeds.
  const legacy =
    word.study_image_data && word.study_image_revision === word.learning_revision
      ? word
      : (
          await tx.query(
            `SELECT image_data AS study_image_data,image_content_type AS study_image_content_type,image_kind AS study_image_kind,image_provider AS study_image_provider,image_model AS study_image_model,image_source_url AS study_image_source_url,image_creator AS study_image_creator
    FROM product_gotit.study_image_assets WHERE product_gotit.word_image_identity(source_language_code,normalized_source_text,translation_language_code,normalized_translation_text)=$1::jsonb ORDER BY updated_at DESC,id LIMIT 1`,
            [identity],
          )
        ).rows[0];
  if (legacy?.study_image_data) {
    await tx.query(
      `INSERT INTO product_gotit.concept_image_assets(application_id,concept_id,image_revision,claim_id,claim_until,image_data,image_content_type,image_kind,image_provider,image_model,image_source_url,image_creator)
      VALUES($1,$2,$3,$4,'epoch',$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
      [
        applicationId,
        concept.id,
        concept.image_revision,
        randomUUID(),
        legacy.study_image_data,
        legacy.study_image_content_type,
        legacy.study_image_kind,
        legacy.study_image_provider,
        legacy.study_image_model,
        legacy.study_image_source_url,
        legacy.study_image_creator,
      ],
    );
  }
  return concept;
}
