import type { Pool } from 'pg';
import { withTransaction, type DatabaseTransaction } from '../../shared/database/transaction.js';
import { AppError } from '../../shared/errors/app-error.js';
import { scopeValues } from '../library/library.repository.js';
import { PROFILE_DEFAULTS } from '../profile/profile.constants.js';
import type { ProfileScope } from '../profile/profile.types.js';
import type { AddInput, KnownInput, RemovalInput } from './word-packs.validation.js';

import { wordPackJourney } from './word-pack-journey.js';
import { unitLearnedPredicate } from './unit-learning.js';

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
      teacherStations: wordPackJourney(Number(row.word_count), Number(row.introduced_count)),
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
        introduced: Number(row.introduced_count),
        linked: Number(row.linked_count),
        new: Number(row.new_count),
        learning: Number(row.learning_count),
        reviewing: Number(row.reviewing_count),
        mastered: Number(row.mastered_count),
        known: Number(row.known_count),
        completed: Number(row.completed_count),
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
          count(DISTINCT known.entry_id)::integer known_count,
          count(DISTINCT e.id) FILTER(WHERE known.entry_id IS NOT NULL OR
            (up.status='active' AND link.excluded_at IS NULL AND li.user_status='active'
              AND li.learning_status IN ('learning','reviewing','mastered')))::integer introduced_count,
          count(DISTINCT e.id) FILTER(WHERE known.entry_id IS NOT NULL OR
            (up.status='active' AND link.excluded_at IS NULL AND li.learning_status='mastered'))::integer completed_count,
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
        LEFT JOIN product_gotit.user_word_pack_known_entries known
          ON known.application_id=$1 AND known.application_user_id=$2
          AND known.pack_id=p.id AND known.entry_id=e.id
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
              link.learning_item_id AS "learningItemId",link.excluded_at AS "excludedAt",
              li.learning_status AS "learningStatus",li.user_status AS "userStatus",
              (link.excluded_at IS NULL AND li.user_status='active' AND ${unitLearnedPredicate('li', 'e.pack_id')}) IS TRUE AS "learned",
              (known.entry_id IS NOT NULL) AS "known"
            FROM product_gotit.word_pack_entries e
            LEFT JOIN product_gotit.learning_item_pack_entries link
              ON link.application_id=$1 AND link.application_user_id=$2 AND link.pack_id=e.pack_id AND link.entry_id=e.id
            LEFT JOIN product_gotit.user_word_pack_known_entries known
              ON known.application_id=$1 AND known.application_user_id=$2 AND known.pack_id=e.pack_id AND known.entry_id=e.id
            LEFT JOIN product_gotit.learning_items li
              ON li.application_id=$1 AND li.application_user_id=$2 AND li.id=link.learning_item_id AND li.deleted_at IS NULL
            WHERE e.pack_id=$3 ORDER BY e.sort_order,e.id`,
            [...scopeValues(scope), id],
          )
        ).rows;
        return { pack: this.dto(row), entries };
      },
      true,
    );
  }

  async image(scope: ProfileScope, id: string, entryId: string) {
    const detail = await this.detail(scope, id);
    if (!detail.entries.some((entry) => entry.id === entryId)) throw missingPack();
    return withTransaction(
      this.pool,
      async (tx) => {
        const row = (
          await tx.query(
            `SELECT li.source_text,li.study_image_data,li.study_image_content_type,
        li.study_image_kind,li.study_image_provider,li.study_image_source_url,li.study_image_creator
        FROM product_gotit.learning_item_pack_entries link
        JOIN product_gotit.learning_items li ON li.id=link.learning_item_id
          AND li.application_id=link.application_id AND li.application_user_id=link.application_user_id
        WHERE link.application_id=$1 AND link.application_user_id=$2 AND link.pack_id=$3
          AND link.entry_id=$4 AND link.excluded_at IS NULL AND li.deleted_at IS NULL
          AND li.study_image_revision=li.learning_revision`,
            [...scopeValues(scope), id, entryId],
          )
        ).rows[0];
        if (
          !row ||
          !Buffer.isBuffer(row.study_image_data) ||
          !row.study_image_data.length ||
          row.study_image_data.length > 3_000_000 ||
          !['image/png', 'image/jpeg', 'image/webp'].includes(row.study_image_content_type) ||
          !['generated', 'stock'].includes(row.study_image_kind) ||
          typeof row.study_image_provider !== 'string' ||
          !row.study_image_provider.length ||
          (row.study_image_kind === 'stock' &&
            !/^https:\/\//i.test(row.study_image_source_url ?? ''))
        )
          return { image: null };
        return {
          image: {
            url: `data:${row.study_image_content_type};base64,${row.study_image_data.toString('base64')}`,
            alt: row.source_text,
            generated: row.study_image_kind === 'generated',
            provider: row.study_image_provider,
            sourceUrl: row.study_image_source_url,
            creator: row.study_image_creator,
          },
        };
      },
      true,
    );
  }

  async setKnown(scope: ProfileScope, id: string, input: KnownInput) {
    return withTransaction(this.pool, async (tx) => {
      await tx.lock(['word-pack', ...scopeValues(scope), id]);
      await tx.query(
        `INSERT INTO product_gotit.user_profiles
          (application_id,application_user_id,default_source_language,default_translation_language,
           timezone,daily_goal_type,daily_goal_value,default_new_items_per_day,
           translation_method_preference,learning_preferences,created_at,updated_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())
         ON CONFLICT(application_id,application_user_id) DO NOTHING`,
        [
          ...scopeValues(scope),
          PROFILE_DEFAULTS.defaultSourceLanguage,
          PROFILE_DEFAULTS.defaultTranslationLanguage,
          PROFILE_DEFAULTS.timezone,
          PROFILE_DEFAULTS.dailyGoal.type,
          PROFILE_DEFAULTS.dailyGoal.value,
          PROFILE_DEFAULTS.defaultNewItemsPerDay,
          PROFILE_DEFAULTS.translationMethodPreference,
          JSON.stringify(PROFILE_DEFAULTS.learningPreferences),
        ],
      );
      const pack = (await this.packRows(tx, scope, id))[0];
      if (!pack) throw missingPack();
      const valid = (
        await tx.query(
          'SELECT count(*)::integer count FROM product_gotit.word_pack_entries WHERE pack_id=$1 AND id=ANY($2::uuid[])',
          [id, input.entryIds],
        )
      ).rows[0]?.count as number | undefined;
      if (valid !== input.entryIds.length)
        throw new AppError(400, 'VALIDATION_ERROR', 'A selected word is not part of this pack');
      const acrossEnglishPath = pack.topic_slug === 'english-learning-path-en-he';
      const targets = acrossEnglishPath
        ? `SELECT DISTINCT target.pack_id,target.id AS entry_id
           FROM product_gotit.word_pack_entries chosen
           JOIN product_gotit.word_pack_entries target
             ON target.normalized_source_text=chosen.normalized_source_text
             AND target.normalized_translation_text=chosen.normalized_translation_text
           JOIN product_gotit.word_packs target_pack ON target_pack.id=target.pack_id
           JOIN product_gotit.word_tracks target_track ON target_track.id=target_pack.track_id
           WHERE chosen.pack_id=$3 AND chosen.id=ANY($4::uuid[])
             AND target_track.topic_id=$5::uuid`
        : `SELECT e.pack_id,e.id AS entry_id FROM product_gotit.word_pack_entries e
           WHERE e.pack_id=$3 AND e.id=ANY($4::uuid[])`;
      const targetValues = [
        ...scopeValues(scope),
        id,
        input.entryIds,
        ...(acrossEnglishPath ? [pack.topic_id] : []),
      ];
      if (input.known) {
        await tx.query(
          `INSERT INTO product_gotit.user_word_pack_known_entries
            (application_id,application_user_id,pack_id,entry_id)
          SELECT $1,$2,target.pack_id,target.entry_id FROM (${targets}) target
          ON CONFLICT DO NOTHING`,
          targetValues,
        );
      } else {
        await tx.query(
          `DELETE FROM product_gotit.user_word_pack_known_entries
          WHERE application_id=$1 AND application_user_id=$2
            AND (pack_id,entry_id) IN (${targets})`,
          targetValues,
        );
      }
      const knownCount = (
        await tx.query(
          `SELECT count(*)::integer count FROM product_gotit.user_word_pack_known_entries
          WHERE application_id=$1 AND application_user_id=$2 AND pack_id=$3`,
          [...scopeValues(scope), id],
        )
      ).rows[0]?.count as number | undefined;
      return { packId: id, knownCount: knownCount ?? 0 };
    });
  }

  async add(scope: ProfileScope, id: string, input: AddInput) {
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
      const selected = new Set(input.entryIds);
      if (entries.filter((entry) => selected.has(entry.id)).length !== selected.size)
        throw new AppError(400, 'VALIDATION_ERROR', 'A selected word is not part of this pack');
      await tx.query(
        `UPDATE product_gotit.learning_item_pack_entries
        SET excluded_at=CASE WHEN entry_id=ANY($4::uuid[]) THEN NULL ELSE COALESCE(excluded_at,now()) END,
            updated_at=now()
        WHERE application_id=$1 AND application_user_id=$2 AND pack_id=$3`,
        [...scopeValues(scope), id, input.entryIds],
      );
      let added = 0,
        linkedExisting = 0,
        restored = 0,
        excluded = entries.length - selected.size;
      for (const entry of entries.filter((candidate) => selected.has(candidate.id))) {
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
        if (prior) {
          if (prior.excluded_at)
            await tx.query(
              `UPDATE product_gotit.learning_item_pack_entries
              SET excluded_at=NULL,updated_at=now()
              WHERE application_id=$1 AND application_user_id=$2 AND pack_id=$3 AND entry_id=$4`,
              [...scopeValues(scope), id, entry.id],
            );
          if (prior.user_status !== 'active' || prior.deleted_at) {
            await tx.query(
              `UPDATE product_gotit.learning_items
              SET user_status='active',deleted_at=NULL,updated_at=now()
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
