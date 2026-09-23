import type { Pool } from 'pg';
import { withTransaction, type DatabaseTransaction } from '../../shared/database/transaction.js';
import { AppError } from '../../shared/errors/app-error.js';
import { scopeValues } from '../library/library.repository.js';
import type { ProfileScope } from '../profile/profile.types.js';
import type { RemovalInput } from './word-packs.validation.js';

type Row = Record<string, any>;

const missingPack = () => new AppError(404, 'NOT_FOUND', 'Word pack not found');

export class WordPackRepository {
  constructor(private readonly pool: Pool) {}

  private dto(row: Row) {
    return {
      id: row.id,
      slug: row.slug,
      title: row.title,
      description: row.description,
      moduleNumber: row.module_number,
      version: row.version,
      wordCount: Number(row.word_count),
      installed: row.installed_status === 'active',
      installedVersion: row.installed_version === null ? null : Number(row.installed_version),
      topic: { id: row.topic_id, slug: row.topic_slug, title: row.topic_title },
      track: {
        id: row.track_id,
        slug: row.track_slug,
        title: row.track_title,
        levelCode: row.level_code,
        cefrFrom: row.cefr_from,
        cefrTo: row.cefr_to,
        sourceLanguageCode: row.source_language_code,
        translationLanguageCode: row.translation_language_code,
      },
      progress: {
        linked: Number(row.linked_count),
        new: Number(row.new_count),
        learning: Number(row.learning_count),
        reviewing: Number(row.reviewing_count),
        mastered: Number(row.mastered_count),
        due: Number(row.due_count),
      },
    };
  }

  private async packRows(tx: DatabaseTransaction, scope: ProfileScope, id?: string) {
    return (
      await tx.query(
        `SELECT p.id,p.slug,p.title,p.description,p.module_number,p.version,p.sort_order,
          tr.id track_id,tr.slug track_slug,tr.title track_title,tr.level_code,tr.cefr_from,tr.cefr_to,
          tr.source_language_code,tr.translation_language_code,tr.sort_order track_sort_order,
          tp.id topic_id,tp.slug topic_slug,tp.title topic_title,tp.sort_order topic_sort_order,
          up.status installed_status,up.installed_version,
          count(DISTINCT e.id)::integer word_count,
          count(DISTINCT link.learning_item_id) FILTER(WHERE up.status='active' AND link.excluded_at IS NULL)::integer linked_count,
          count(DISTINCT li.id) FILTER(WHERE up.status='active' AND link.excluded_at IS NULL AND li.learning_status='new')::integer new_count,
          count(DISTINCT li.id) FILTER(WHERE up.status='active' AND link.excluded_at IS NULL AND li.learning_status='learning')::integer learning_count,
          count(DISTINCT li.id) FILTER(WHERE up.status='active' AND link.excluded_at IS NULL AND li.learning_status='reviewing')::integer reviewing_count,
          count(DISTINCT li.id) FILTER(WHERE up.status='active' AND link.excluded_at IS NULL AND li.learning_status='mastered')::integer mastered_count,
          count(DISTINCT li.id) FILTER(WHERE up.status='active' AND link.excluded_at IS NULL AND li.next_review_at<=now())::integer due_count
        FROM product_gotit.word_packs p
        JOIN product_gotit.word_tracks tr ON tr.id=p.track_id AND tr.is_active
        JOIN product_gotit.word_topics tp ON tp.id=tr.topic_id AND tp.is_active
        JOIN product_gotit.word_pack_entries e ON e.pack_id=p.id
        LEFT JOIN product_gotit.user_profiles profile
          ON profile.application_id=$1 AND profile.application_user_id=$2
        LEFT JOIN product_gotit.user_word_packs up ON up.application_id=$1 AND up.application_user_id=$2 AND up.pack_id=p.id
        LEFT JOIN product_gotit.learning_item_pack_entries link ON link.application_id=$1 AND link.application_user_id=$2 AND link.pack_id=p.id AND link.entry_id=e.id
        LEFT JOIN product_gotit.learning_items li ON li.application_id=$1 AND li.application_user_id=$2 AND li.id=link.learning_item_id AND li.deleted_at IS NULL
        WHERE p.is_active AND ($3::uuid IS NULL OR p.id=$3)
          AND (profile.default_source_language IS NULL OR
            split_part(lower(profile.default_source_language),'-',1)=split_part(lower(tr.source_language_code),'-',1))
          AND (profile.default_translation_language IS NULL OR
            split_part(lower(profile.default_translation_language),'-',1)=split_part(lower(tr.translation_language_code),'-',1))
        GROUP BY p.id,tr.id,tp.id,up.status,up.installed_version
        ORDER BY tp.sort_order,tr.sort_order,p.sort_order,p.id`,
        [...scopeValues(scope), id ?? null],
      )
    ).rows;
  }

  async list(scope: ProfileScope) {
    return withTransaction(
      this.pool,
      async (tx) => ({ packs: (await this.packRows(tx, scope)).map((row) => this.dto(row)) }),
      true,
    );
  }

  async detail(scope: ProfileScope, id: string) {
    return withTransaction(
      this.pool,
      async (tx) => {
        const row = (await this.packRows(tx, scope, id))[0];
        if (!row) throw missingPack();
        const entries = (
          await tx.query(
            `SELECT e.id,e.source_text AS "sourceText",e.translation_text AS "translationText",
              e.item_type AS "itemType",e.part_of_speech AS "partOfSpeech",e.example_text AS "exampleText",
              link.learning_item_id AS "learningItemId",link.excluded_at AS "excludedAt"
            FROM product_gotit.word_pack_entries e
            LEFT JOIN product_gotit.learning_item_pack_entries link
              ON link.application_id=$1 AND link.application_user_id=$2 AND link.pack_id=e.pack_id AND link.entry_id=e.id
            WHERE e.pack_id=$3 ORDER BY e.sort_order,e.id`,
            [...scopeValues(scope), id],
          )
        ).rows;
        return { pack: this.dto(row), entries };
      },
      true,
    );
  }

  async add(scope: ProfileScope, id: string) {
    return withTransaction(this.pool, async (tx) => {
      await tx.lock(['word-pack', ...scopeValues(scope), id]);
      const pack = (
        await tx.query(
          `SELECT p.id,p.version,tr.source_language_code,tr.translation_language_code
          FROM product_gotit.word_packs p JOIN product_gotit.word_tracks tr ON tr.id=p.track_id
          JOIN product_gotit.word_topics tp ON tp.id=tr.topic_id
          LEFT JOIN product_gotit.user_profiles profile
            ON profile.application_id=$2 AND profile.application_user_id=$3
          WHERE p.id=$1 AND p.is_active AND tr.is_active AND tp.is_active
            AND (profile.default_source_language IS NULL OR
              split_part(lower(profile.default_source_language),'-',1)=split_part(lower(tr.source_language_code),'-',1))
            AND (profile.default_translation_language IS NULL OR
              split_part(lower(profile.default_translation_language),'-',1)=split_part(lower(tr.translation_language_code),'-',1))
          FOR SHARE OF p,tr,tp`,
          [id, ...scopeValues(scope)],
        )
      ).rows[0];
      if (!pack) throw missingPack();
      await tx.query(
        `INSERT INTO product_gotit.user_word_packs
          (application_id,application_user_id,pack_id,status,installed_version,added_at,removed_at,updated_at)
        VALUES($1,$2,$3,'active',$4,now(),NULL,now())
        ON CONFLICT(application_id,application_user_id,pack_id) DO UPDATE
          SET status='active',installed_version=EXCLUDED.installed_version,removed_at=NULL,updated_at=now()`,
        [...scopeValues(scope), id, pack.version],
      );
      const entries = (
        await tx.query(
          'SELECT * FROM product_gotit.word_pack_entries WHERE pack_id=$1 ORDER BY sort_order,id',
          [id],
        )
      ).rows;
      let added = 0,
        linkedExisting = 0,
        restored = 0,
        excluded = 0;
      for (const entry of entries) {
        const prior = (
          await tx.query(
            `SELECT link.learning_item_id,link.excluded_at,li.user_status,li.deleted_at
            FROM product_gotit.learning_item_pack_entries link
            JOIN product_gotit.learning_items li ON li.application_id=link.application_id
              AND li.application_user_id=link.application_user_id AND li.id=link.learning_item_id
            WHERE link.application_id=$1 AND link.application_user_id=$2 AND link.pack_id=$3 AND link.entry_id=$4
            FOR UPDATE`,
            [...scopeValues(scope), id, entry.id],
          )
        ).rows[0];
        if (prior?.excluded_at || prior?.deleted_at) {
          excluded++;
          continue;
        }
        if (prior) {
          if (prior.user_status !== 'active') {
            await tx.query(
              `UPDATE product_gotit.learning_items SET user_status='active',updated_at=now()
              WHERE application_id=$1 AND application_user_id=$2 AND id=$3`,
              [...scopeValues(scope), prior.learning_item_id],
            );
            restored++;
          } else linkedExisting++;
          continue;
        }
        await tx.lock([
          'word-pack-entry',
          ...scopeValues(scope),
          entry.normalized_source_text,
          pack.source_language_code,
          pack.translation_language_code,
        ]);
        let item = (
          await tx.query(
            `SELECT li.id,li.user_status FROM product_gotit.learning_items li
            WHERE li.application_id=$1 AND li.application_user_id=$2
              AND li.normalized_source_text=$3 AND li.source_language_code=$4
              AND li.translation_language_code=$5 AND li.deleted_at IS NULL
              AND EXISTS(SELECT 1 FROM product_gotit.item_translations t
                WHERE t.application_id=li.application_id AND t.application_user_id=li.application_user_id
                  AND t.learning_item_id=li.id AND t.is_current AND t.normalized_text=$6)
            ORDER BY li.created_at,li.id LIMIT 1 FOR UPDATE`,
            [
              ...scopeValues(scope),
              entry.normalized_source_text,
              pack.source_language_code,
              pack.translation_language_code,
              entry.normalized_translation_text,
            ],
          )
        ).rows[0];
        if (!item) {
          const created = (
            await tx.query(
              `INSERT INTO product_gotit.learning_items
                (application_id,application_user_id,source_text,normalized_source_text,source_language_code,
                 translation_language_code,item_type,part_of_speech)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,user_status`,
              [
                ...scopeValues(scope),
                entry.source_text,
                entry.normalized_source_text,
                pack.source_language_code,
                pack.translation_language_code,
                entry.item_type,
                entry.part_of_speech,
              ],
            )
          ).rows[0];
          if (!created) throw new AppError(500, 'INTERNAL_ERROR', 'Word pack item was not created');
          item = created;
          await tx.query(
            `INSERT INTO product_gotit.item_translations
              (application_id,application_user_id,learning_item_id,translation_text,normalized_text,is_primary,source_kind)
            VALUES($1,$2,$3,$4,$5,true,'catalog')`,
            [
              ...scopeValues(scope),
              item.id,
              entry.translation_text,
              entry.normalized_translation_text,
            ],
          );
          if (entry.example_text)
            await tx.query(
              `INSERT INTO product_gotit.item_examples
                (application_id,application_user_id,learning_item_id,example_text,source_kind,learning_revision)
              VALUES($1,$2,$3,$4,'catalog',1)`,
              [...scopeValues(scope), item.id, entry.example_text],
            );
          await tx.query(
            `INSERT INTO product_gotit.item_skill_progress
              (application_id,application_user_id,learning_item_id,skill_type,algorithm_version)
            SELECT $1,$2,$3,skill,'pending-learning-engine'
            FROM unnest(ARRAY['recognition','recall','listening','spelling','pronunciation']) skill
            ON CONFLICT(learning_item_id,skill_type) DO NOTHING`,
            [...scopeValues(scope), item.id],
          );
          added++;
        } else {
          if (item.user_status !== 'active') {
            await tx.query(
              `UPDATE product_gotit.learning_items SET user_status='active',updated_at=now()
              WHERE application_id=$1 AND application_user_id=$2 AND id=$3`,
              [...scopeValues(scope), item.id],
            );
            restored++;
          } else linkedExisting++;
        }
        await tx.query(
          `INSERT INTO product_gotit.learning_item_pack_entries
            (application_id,application_user_id,pack_id,entry_id,learning_item_id)
          VALUES($1,$2,$3,$4,$5)`,
          [...scopeValues(scope), id, entry.id, item.id],
        );
      }
      return {
        packId: id,
        added,
        linkedExisting,
        restored,
        excluded,
        total: entries.length,
      };
    });
  }

  async remove(scope: ProfileScope, id: string, input: RemovalInput) {
    return withTransaction(this.pool, async (tx) => {
      await tx.lock(['word-pack', ...scopeValues(scope), id]);
      const membership = (
        await tx.query(
          `SELECT status FROM product_gotit.user_word_packs
          WHERE application_id=$1 AND application_user_id=$2 AND pack_id=$3 FOR UPDATE`,
          [...scopeValues(scope), id],
        )
      ).rows[0];
      if (!membership) throw missingPack();
      if (membership.status === 'removed')
        return { packId: id, mode: input.mode, archived: 0, retained: 0 };
      const linked = (
        await tx.query(
          `SELECT DISTINCT learning_item_id FROM product_gotit.learning_item_pack_entries
          WHERE application_id=$1 AND application_user_id=$2 AND pack_id=$3 AND excluded_at IS NULL`,
          [...scopeValues(scope), id],
        )
      ).rows.map((row) => row.learning_item_id as string);
      if (input.mode === 'keep_words')
        await tx.query(
          `UPDATE product_gotit.learning_item_pack_entries SET kept_by_user=true,updated_at=now()
          WHERE application_id=$1 AND application_user_id=$2 AND pack_id=$3 AND excluded_at IS NULL`,
          [...scopeValues(scope), id],
        );
      await tx.query(
        `UPDATE product_gotit.user_word_packs SET status='removed',removed_at=now(),updated_at=now()
        WHERE application_id=$1 AND application_user_id=$2 AND pack_id=$3`,
        [...scopeValues(scope), id],
      );
      let archived = 0;
      if (input.mode === 'archive_exclusive' && linked.length) {
        archived =
          (
            await tx.query(
              `UPDATE product_gotit.learning_items li SET user_status='archived',updated_at=now()
              WHERE li.application_id=$1 AND li.application_user_id=$2 AND li.id=ANY($3::uuid[])
                AND li.deleted_at IS NULL
                AND NOT EXISTS(SELECT 1 FROM product_gotit.item_occurrences o
                  WHERE o.application_id=li.application_id AND o.application_user_id=li.application_user_id
                    AND o.learning_item_id=li.id)
                AND NOT EXISTS(SELECT 1 FROM product_gotit.learning_item_pack_entries keep
                  WHERE keep.application_id=li.application_id AND keep.application_user_id=li.application_user_id
                    AND keep.learning_item_id=li.id AND keep.kept_by_user)
                AND NOT EXISTS(SELECT 1 FROM product_gotit.learning_item_pack_entries other
                  JOIN product_gotit.user_word_packs active
                    ON active.application_id=other.application_id AND active.application_user_id=other.application_user_id
                    AND active.pack_id=other.pack_id AND active.status='active'
                  WHERE other.application_id=li.application_id AND other.application_user_id=li.application_user_id
                    AND other.learning_item_id=li.id AND other.excluded_at IS NULL)
              RETURNING li.id`,
              [...scopeValues(scope), linked],
            )
          ).rowCount ?? 0;
      }
      return {
        packId: id,
        mode: input.mode,
        archived,
        retained: linked.length - archived,
      };
    });
  }
}
