import type { Pool } from 'pg';
import type { ProfileScope } from '../profile/profile.types.js';
import { lookupText } from '../capture/capture.validation.js';

export type CourseWord = {
  sourceText: string;
  choices: Array<{ id: string; translationText: string }>;
};
export interface CourseWordSource {
  resolve(
    scope: ProfileScope,
    words: string[],
    target: string,
    support: string,
  ): Promise<CourseWord[]>;
}
/** Match saved meanings only. A syllabus string never becomes a learning item by itself. */
export class PostgresCourseWordSource implements CourseWordSource {
  constructor(private readonly pool: Pool) {}
  async resolve(
    scope: ProfileScope,
    words: string[],
    target: string,
    support: string,
  ): Promise<CourseWord[]> {
    const unique = [...new Set(words.map(lookupText))];
    if (!unique.length) return [];
    const { rows } = await this.pool.query<{
      normalized: string;
      id: string;
      translationText: string;
    }>(
      `SELECT wanted.normalized, matched.id, matched."translationText"
       FROM unnest($3::text[]) wanted(normalized)
       CROSS JOIN LATERAL (
         SELECT li.id, t.translation_text AS "translationText"
         FROM product_gotit.learning_items li
         JOIN product_gotit.item_translations t ON t.application_id=li.application_id
           AND t.application_user_id=li.application_user_id AND t.learning_item_id=li.id
           AND t.is_primary AND t.is_current
         WHERE li.application_id=$1 AND li.application_user_id=$2
           AND li.normalized_source_text=wanted.normalized AND li.source_language_code=$4
           AND li.translation_language_code=$5 AND li.deleted_at IS NULL AND li.user_status='active'
         ORDER BY li.created_at, li.id LIMIT 20
       ) matched`,
      [scope.applicationId, scope.applicationUserId, unique, target, support],
    );
    return words.map((sourceText) => ({
      sourceText,
      choices: rows
        .filter((row) => row.normalized === lookupText(sourceText))
        .map(({ id, translationText }) => ({ id, translationText })),
    }));
  }
}
