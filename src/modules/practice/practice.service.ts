import { randomUUID, randomInt } from 'node:crypto';
import type { Pool } from 'pg';
import { sessionReceiptSchema, attemptReceiptSchema } from './practice.receipts.js';
import { withTransaction, type DatabaseTransaction } from '../../shared/database/transaction.js';
import { AppError } from '../../shared/errors/app-error.js';
import type {
  ProfileScope,
  ProfileServiceContract,
  GotItProfile,
} from '../profile/profile.types.js';
import { scopeValues, itemSnapshot, itemNotFound } from '../library/library.repository.js';
import { fingerprint } from '../enrichment/selection-proof.js';
import { lookupText } from '../capture/capture.validation.js';
import {
  DEFAULT_LEARNING_POLICY,
  policyVersion,
  calendarDay,
  previousDay,
  levelForXp,
  xpAwardForDailyTotal,
  projectEvidence,
  projectOverallMastery,
  decideProgress,
  retentionLevelFor,
  masteryRequirements,
  LEARNED_REVIEW_STAGE,
  type LearningPolicy,
  type Evidence,
  type MasteryEvidence,
  type Skill,
} from '../learning/learning.policy.js';
import { scoreAnswer, type AnswerSpec } from './practice.scoring.js';
import type {
  SessionInput,
  SessionScope,
  ExercisesInput,
  AttemptInput,
} from './practice.validation.js';
import {
  literalStudyImageBrief,
  type GeneratedStudyImage,
  type StudyImageProvider,
} from './study-image.provider.js';

export function answerWordLengths(answer: string) {
  return answer
    .trim()
    .split(/\s+/u)
    .map((word) => [...word].length);
}

const missingSession = () => new AppError(404, 'NOT_FOUND', 'Practice session not found');
type DbItem = Record<string, any>;
type ExerciseType = 'flashcards' | 'recall' | 'listening_spelling' | 'matching' | 'pronunciation';
const SMART_LEARNING_ORDER: ExerciseType[] = [
  'matching',
  'flashcards',
  'pronunciation',
  'recall',
  'listening_spelling',
];

function isHttpsUrl(value: unknown) {
  try {
    return typeof value === 'string' && new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function studyImageDto(
  data: Buffer,
  contentType: string,
  sourceText: string,
  translationText: string,
  metadata: Pick<GeneratedStudyImage, 'kind' | 'provider' | 'sourceUrl' | 'creator'>,
) {
  if (
    !Buffer.isBuffer(data) ||
    !data.length ||
    data.length > 3_000_000 ||
    !['image/jpeg', 'image/png', 'image/webp'].includes(contentType) ||
    !['generated', 'stock'].includes(metadata.kind) ||
    typeof metadata.provider !== 'string' ||
    !metadata.provider.length ||
    (metadata.kind === 'stock' && !isHttpsUrl(metadata.sourceUrl))
  )
    return null;
  return {
    url: `data:${contentType};base64,${data.toString('base64')}`,
    alt: `תמונה עבור ${sourceText} — ${translationText}`,
    generated: metadata.kind === 'generated',
    provider: metadata.provider,
    sourceUrl: metadata.sourceUrl,
    creator: metadata.creator,
  };
}

export function smartLearningSequence(skills: Skill[], matchingAvailable = true): ExerciseType[] {
  return [
    ...(matchingAvailable && skills.includes('recognition') ? (['matching'] as const) : []),
    ...(skills.includes('recognition') ? (['flashcards'] as const) : []),
    ...(skills.includes('pronunciation') ? (['pronunciation'] as const) : []),
    ...(skills.includes('recall') ? (['recall'] as const) : []),
    ...(skills.includes('listening') && skills.includes('spelling')
      ? (['listening_spelling'] as const)
      : []),
  ];
}

export function nextSmartLearningExercise(
  skills: Skill[],
  attemptedTypes: Iterable<string>,
  matchingAvailable = true,
): ExerciseType | undefined {
  const attempted = new Set(attemptedTypes);
  return smartLearningSequence(skills, matchingAvailable).find((type) => !attempted.has(type));
}

export class PracticeService {
  readonly version: string;
  constructor(
    readonly pool: Pool,
    private readonly profiles: ProfileServiceContract,
    readonly policy: LearningPolicy = DEFAULT_LEARNING_POLICY,
    private readonly speechAvailable: (
      language: string,
      kind: 'listening' | 'pronunciation',
    ) => boolean = () => false,
    private readonly imageProvider?: StudyImageProvider,
  ) {
    this.version = policyVersion(policy);
  }
  availableSkills(profile: GotItProfile, language: string): Skill[] {
    return (
      profile.learningPreferences?.enabledSkills ?? [
        'recognition',
        'recall',
        'listening',
        'spelling',
        'pronunciation',
      ]
    ).filter(
      (s) =>
        !['listening', 'pronunciation'].includes(s) ||
        this.speechAvailable(language, s as 'listening' | 'pronunciation'),
    );
  }
  async queue(scope: ProfileScope, count = 20) {
    const profile = await this.profiles.getProfile(scope);
    return withTransaction(
      this.pool,
      async (tx) => {
        const rows = await this.queueRows(tx, scope, profile, count);
        return {
          items: rows.map((r) => ({
            id: r.id,
            sourceText: r.source_text,
            sourceLanguageCode: r.source_language_code,
            translationLanguageCode: r.translation_language_code,
            primaryTranslation: r.primary_translation,
            learningStatus: r.learning_status,
            retentionLevel: retentionLevelFor(r.learning_status, r.review_stage),
            nextReviewAt: r.next_review_at,
            queueScore: Number(r.queue_score),
          })),
          algorithmVersion: this.version,
        };
      },
      true,
    );
  }
  private async queueRows(
    tx: DatabaseTransaction,
    scope: ProfileScope,
    profile: GotItProfile,
    count: number,
    eligibleIds?: string[],
  ) {
    return (
      await tx.query(
        `WITH candidates AS(SELECT li.*,
      (SELECT translation_text FROM product_gotit.item_translations t WHERE t.application_id=li.application_id AND t.application_user_id=li.application_user_id AND t.learning_item_id=li.id AND t.is_current AND is_primary) primary_translation,
      (CASE WHEN li.next_review_at<=now() THEN 100+LEAST(100,EXTRACT(epoch FROM now()-li.next_review_at)/86400) ELSE 0 END
       +(100-li.overall_mastery_score)/2+CASE WHEN li.user_priority='high' THEN 30 ELSE 0 END
       +CASE WHEN li.manual_hard THEN 20 ELSE 0 END+COALESCE(li.system_difficulty,0)*20
       +CASE WHEN li.overall_mastery_score BETWEEN 70 AND 84 THEN 10 ELSE 0 END
       +CASE WHEN li.learning_status='new' THEN 15 ELSE 0 END
       +CASE WHEN li.learning_status<>'mastered'
         AND (SELECT count(*) FROM product_gotit.practice_attempts scored
           WHERE scored.application_id=li.application_id AND scored.application_user_id=li.application_user_id
             AND scored.learning_item_id=li.id AND scored.result<>'skipped'
             AND COALESCE(scored.learning_revision,1)=li.learning_revision)>=$5
         AND NOT EXISTS(SELECT 1 FROM product_gotit.practice_attempts today
           WHERE today.application_id=li.application_id AND today.application_user_id=li.application_user_id
             AND today.learning_item_id=li.id AND today.result<>'skipped' AND today.score>=85
             AND today.user_answer_text IS NOT NULL AND COALESCE(today.learning_revision,1)=li.learning_revision
             AND (today.created_at AT TIME ZONE $4)::date=(now() AT TIME ZONE $4)::date
             AND EXISTS(SELECT 1 FROM product_gotit.attempt_skill_effects effect
               WHERE effect.practice_attempt_id=today.id AND effect.skill_type='recall'))
         AND (li.review_stage<${LEARNED_REVIEW_STAGE}
           OR li.overall_mastery_score<$8
           OR (SELECT count(*) FROM product_gotit.practice_attempts successful
             WHERE successful.application_id=li.application_id AND successful.application_user_id=li.application_user_id
               AND successful.learning_item_id=li.id AND successful.result<>'skipped' AND successful.score>=85
               AND successful.user_answer_text IS NOT NULL AND COALESCE(successful.learning_revision,1)=li.learning_revision
               AND EXISTS(SELECT 1 FROM product_gotit.attempt_skill_effects effect
                 WHERE effect.practice_attempt_id=successful.id AND effect.skill_type='recall'))<$6
           OR (SELECT count(DISTINCT (successful.created_at AT TIME ZONE $4)::date)
             FROM product_gotit.practice_attempts successful
             WHERE successful.application_id=li.application_id AND successful.application_user_id=li.application_user_id
               AND successful.learning_item_id=li.id AND successful.result<>'skipped' AND successful.score>=85
               AND successful.user_answer_text IS NOT NULL AND COALESCE(successful.learning_revision,1)=li.learning_revision
               AND EXISTS(SELECT 1 FROM product_gotit.attempt_skill_effects effect
                 WHERE effect.practice_attempt_id=successful.id AND effect.skill_type='recall'))<$7)
         THEN 120 ELSE 0 END) queue_score,
      row_number() OVER(PARTITION BY learning_status ORDER BY created_at,id) new_rank
      FROM product_gotit.learning_items li WHERE application_id=$1 AND application_user_id=$2
        AND user_status='active' AND deleted_at IS NULL
        AND ($10::uuid[] IS NULL OR li.id=ANY($10::uuid[])))
      SELECT * FROM candidates WHERE primary_translation IS NOT NULL AND
      (learning_status<>'new' OR new_rank<=GREATEST(0,$3-(SELECT count(DISTINCT a.learning_item_id) FROM product_gotit.practice_attempts a
       JOIN product_gotit.learning_items i ON i.application_id=a.application_id AND i.application_user_id=a.application_user_id AND i.id=a.learning_item_id
       WHERE a.application_id=$1 AND a.application_user_id=$2 AND (a.created_at AT TIME ZONE $4)::date=(now() AT TIME ZONE $4)::date AND a.result<>'skipped' AND NOT EXISTS(SELECT 1 FROM product_gotit.practice_attempts older WHERE older.application_id=a.application_id AND older.application_user_id=a.application_user_id AND older.learning_item_id=a.learning_item_id AND older.result<>'skipped' AND (older.created_at AT TIME ZONE $4)::date<(now() AT TIME ZONE $4)::date))))
       AND (learning_status<>'mastered' OR next_review_at<=now()) ORDER BY queue_score DESC,created_at,id LIMIT $9`,
        [
          ...scopeValues(scope),
          profile.defaultNewItemsPerDay,
          profile.timezone,
          this.policy.minimumScoredAttempts,
          this.policy.minimumActiveRecallSuccesses,
          this.policy.minimumActiveRecallCalendarDays,
          this.policy.masteryThreshold,
          count,
          eligibleIds ?? null,
        ],
      )
    ).rows;
  }
  private async resolveSessionScope(
    tx: DatabaseTransaction,
    scope: ProfileScope,
    selection: SessionScope,
  ) {
    const definitions = {
      pack: {
        sql: `SELECT p.id,p.title FROM product_gotit.word_packs p
          JOIN product_gotit.user_word_packs up ON up.pack_id=p.id
            AND up.application_id=$1 AND up.application_user_id=$2 AND up.status='active'
          WHERE p.id=$3 AND p.is_active`,
        predicate: 'p.id=$3',
      },
      track: {
        sql: `SELECT tr.id,tr.title FROM product_gotit.word_tracks tr
          WHERE tr.id=$3 AND tr.is_active AND EXISTS(SELECT 1 FROM product_gotit.word_packs installed
            JOIN product_gotit.user_word_packs up ON up.pack_id=installed.id
              AND up.application_id=$1 AND up.application_user_id=$2 AND up.status='active'
            WHERE installed.track_id=tr.id)`,
        predicate: 'p.track_id=$3',
      },
      topic: {
        sql: `SELECT tp.id,tp.title FROM product_gotit.word_topics tp
          WHERE tp.id=$3 AND tp.is_active AND EXISTS(SELECT 1 FROM product_gotit.word_tracks tr
            JOIN product_gotit.word_packs installed ON installed.track_id=tr.id
            JOIN product_gotit.user_word_packs up ON up.pack_id=installed.id
              AND up.application_id=$1 AND up.application_user_id=$2 AND up.status='active'
            WHERE tr.topic_id=tp.id)`,
        predicate: 'tr.topic_id=$3',
      },
    } as const;
    const definition = definitions[selection.type];
    const descriptor = (await tx.query(definition.sql, [...scopeValues(scope), selection.id]))
      .rows[0];
    if (!descriptor)
      throw new AppError(
        409,
        'WORD_PACK_NOT_ADDED',
        'Add this word pack before starting a session',
      );
    const ids = (
      await tx.query(
        `SELECT DISTINCT link.learning_item_id
        FROM product_gotit.learning_item_pack_entries link
        JOIN product_gotit.user_word_packs up ON up.application_id=link.application_id
          AND up.application_user_id=link.application_user_id AND up.pack_id=link.pack_id AND up.status='active'
        JOIN product_gotit.word_packs p ON p.id=link.pack_id AND p.is_active
        JOIN product_gotit.word_tracks tr ON tr.id=p.track_id AND tr.is_active
        WHERE link.application_id=$1 AND link.application_user_id=$2 AND link.excluded_at IS NULL
          AND ${definition.predicate}`,
        [...scopeValues(scope), selection.id],
      )
    ).rows.map((row) => row.learning_item_id as string);
    return {
      ids,
      snapshot: { type: selection.type, id: selection.id, title: descriptor.title as string },
    };
  }
  private sessionDto(row: DbItem) {
    const selection = row.selection ?? {};
    return {
      id: row.id,
      sessionType: row.session_type,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      durationSeconds: row.duration_seconds,
      itemCount: row.item_count,
      attemptCount: row.attempt_count,
      correctCount: row.correct_count,
      xpEarned: row.xp_earned,
      algorithmVersion: row.algorithm_version,
      scope: selection.scope ?? null,
    };
  }
  private async session(tx: DatabaseTransaction, scope: ProfileScope, id: string) {
    const row = (
      await tx.query(
        'SELECT * FROM product_gotit.practice_sessions WHERE application_id=$1 AND application_user_id=$2 AND id=$3 FOR UPDATE',
        [...scopeValues(scope), id],
      )
    ).rows[0];
    if (!row) throw missingSession();
    return row;
  }
  async createSession(scope: ProfileScope, key: string, input: SessionInput) {
    const profile = await this.profiles.getProfile(scope);
    const hash = fingerprint(input);
    return withTransaction(this.pool, async (tx) => {
      await tx.lock(['practice-session-event', ...scopeValues(scope), key]);
      const prior = (
        await tx.query(
          'SELECT id,request_hash,response_receipt FROM product_gotit.practice_sessions WHERE application_id=$1 AND application_user_id=$2 AND client_event_id=$3',
          [...scopeValues(scope), key],
        )
      ).rows[0];
      if (prior) {
        if (prior.request_hash !== hash)
          throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Session event key was reused');
        const parsed = sessionReceiptSchema.safeParse(prior.response_receipt);
        if (!parsed.success || parsed.data.requestHash !== hash || parsed.data.data.id !== prior.id)
          throw new AppError(500, 'INTERNAL_ERROR', 'Invalid session receipt');
        return { session: parsed.data.data, replayed: true };
      }
      let ids = input.learningItemIds;
      let scopeSnapshot: { type: string; id: string; title: string } | null = null;
      if (input.readingId) {
        const content = await tx.query(
          'SELECT id FROM product_gotit.generated_contents WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL AND opened_at IS NOT NULL',
          [...scopeValues(scope), input.readingId],
        );
        if (!content.rowCount) throw new AppError(404, 'NOT_FOUND', 'Reading content not found');
        const targets = (
          await tx.query(
            'SELECT learning_item_id FROM product_gotit.generated_content_items WHERE application_id=$1 AND application_user_id=$2 AND generated_content_id=$3',
            [...scopeValues(scope), input.readingId],
          )
        ).rows.map((r) => r.learning_item_id as string);
        if (ids && ids.some((id) => !targets.includes(id))) throw itemNotFound();
        ids = ids ?? targets;
      }
      if (input.scope) {
        const resolved = await this.resolveSessionScope(tx, scope, input.scope);
        scopeSnapshot = resolved.snapshot;
        ids = resolved.ids;
      }
      if (!ids) ids = (await this.queueRows(tx, scope, profile, input.count)).map((r) => r.id);
      if (!ids.length) throw new AppError(409, 'NO_ELIGIBLE_ITEMS', 'No eligible learning items');
      const items = (
        await tx.query(
          `SELECT id,source_language_code FROM product_gotit.learning_items WHERE application_id=$1 AND application_user_id=$2 AND id=ANY($3::uuid[]) AND user_status='active' AND deleted_at IS NULL FOR SHARE`,
          [...scopeValues(scope), ids],
        )
      ).rows;
      if (items.length !== ids.length) throw itemNotFound();
      if (
        ['listening_spelling', 'pronunciation'].includes(input.sessionType) &&
        items.some(
          (i) =>
            !this.speechAvailable(
              i.source_language_code,
              input.sessionType === 'pronunciation' ? 'pronunciation' : 'listening',
            ),
        )
      )
        throw new AppError(
          503,
          'SPEECH_NOT_CONFIGURED',
          'Speech provider is unavailable for this language',
        );
      const row = (
        await tx.query(
          `INSERT INTO product_gotit.practice_sessions(application_id,application_user_id,session_type,status,started_at,item_count,algorithm_version,client_event_id,request_hash,selection)
        VALUES($1,$2,$3,'active',now(),$4,$5,$6,$7,$8) RETURNING *`,
          [
            ...scopeValues(scope),
            input.sessionType,
            ids.length,
            this.version,
            key,
            hash,
            JSON.stringify({
              itemIds: ids,
              readingId: input.readingId ?? null,
              scope: scopeSnapshot,
            }),
          ],
        )
      ).rows[0]!;
      const session = this.sessionDto(row);
      await tx.query(
        'UPDATE product_gotit.practice_sessions SET response_receipt=$4 WHERE application_id=$1 AND application_user_id=$2 AND id=$3',
        [...scopeValues(scope), row.id, JSON.stringify({ requestHash: hash, data: session })],
      );
      return { session, replayed: false };
    });
  }
  async getSession(scope: ProfileScope, id: string) {
    return withTransaction(this.pool, async (tx) => {
      const row = await this.session(tx, scope, id);
      const attempts = (
        await tx.query(
          `SELECT id,learning_item_id AS "learningItemId",exercise_type AS "exerciseType",result,score::float8 AS score,attempt_sequence AS sequence,created_at AS "createdAt" FROM product_gotit.practice_attempts WHERE application_id=$1 AND application_user_id=$2 AND practice_session_id=$3 ORDER BY attempt_sequence DESC LIMIT 100`,
          [...scopeValues(scope), id],
        )
      ).rows;
      return {
        ...this.sessionDto(row),
        accuracy: row.attempt_count ? row.correct_count / row.attempt_count : 0,
        attempts,
      };
    });
  }
  async studyCards(scope: ProfileScope, id: string) {
    return withTransaction(this.pool, async (tx) => {
      const session = await this.session(tx, scope, id);
      if (session.status !== 'active')
        throw new AppError(409, 'SESSION_CLOSED', 'Session is closed');
      const ids = session.selection.itemIds as string[];
      const rows = (
        await tx.query(
          `SELECT li.id,li.source_text,li.source_language_code,li.translation_language_code,
              (SELECT translation_text FROM product_gotit.item_translations t
                WHERE t.application_id=li.application_id AND t.application_user_id=li.application_user_id
                  AND t.learning_item_id=li.id AND t.is_current
                ORDER BY t.is_primary DESC,t.id LIMIT 1) translation_text,
              COALESCE((SELECT sentence_text FROM product_gotit.item_occurrences o
                WHERE o.application_id=li.application_id AND o.application_user_id=li.application_user_id
                  AND o.learning_item_id=li.id AND o.learning_revision=li.learning_revision
                  AND o.sentence_text IS NOT NULL ORDER BY o.captured_at DESC,o.id LIMIT 1),
                (SELECT example_text FROM product_gotit.item_examples ex
                  WHERE ex.application_id=li.application_id AND ex.application_user_id=li.application_user_id
                    AND ex.learning_item_id=li.id AND ex.learning_revision=li.learning_revision
                  ORDER BY (ex.source_kind='user') DESC,ex.created_at,ex.id LIMIT 1)) context
            FROM product_gotit.learning_items li
            WHERE li.application_id=$1 AND li.application_user_id=$2 AND li.id=ANY($3::uuid[])
              AND li.deleted_at IS NULL
            ORDER BY array_position($3::uuid[],li.id)`,
          [...scopeValues(scope), ids],
        )
      ).rows;
      if (rows.length !== ids.length || rows.some((row) => !row.translation_text))
        throw new AppError(409, 'ITEM_INCOMPLETE', 'A study item is unavailable or incomplete');
      return {
        cards: rows.map((row) => ({
          learningItemId: row.id,
          sourceText: row.source_text,
          translationText: row.translation_text,
          sourceLanguageCode: row.source_language_code,
          translationLanguageCode: row.translation_language_code,
          context: row.context,
          audioUrl: this.speechAvailable(row.source_language_code, 'listening')
            ? `/api/v1/learning-items/${row.id}/audio`
            : null,
        })),
      };
    });
  }
  async studyImage(scope: ProfileScope, sessionId: string, itemId: string) {
    const item = await withTransaction(this.pool, async (tx) => {
      const session = await this.session(tx, scope, sessionId);
      if (session.status !== 'active')
        throw new AppError(409, 'SESSION_CLOSED', 'Session is closed');
      if (!(session.selection.itemIds as string[]).includes(itemId)) throw itemNotFound();
      const row = (
        await tx.query(
          `SELECT li.source_text,li.source_language_code,li.translation_language_code,
             li.learning_revision,li.study_image_data,li.study_image_content_type,
             li.study_image_model,li.study_image_revision,
             li.study_image_kind,li.study_image_provider,li.study_image_source_url,
             li.study_image_creator,li.normalized_source_text,
             (SELECT translation_text FROM product_gotit.item_translations t
               WHERE t.application_id=li.application_id AND t.application_user_id=li.application_user_id
                 AND t.learning_item_id=li.id AND t.is_current
               ORDER BY t.is_primary DESC,t.id LIMIT 1) translation_text,
             (SELECT normalized_text FROM product_gotit.item_translations t
               WHERE t.application_id=li.application_id AND t.application_user_id=li.application_user_id
                 AND t.learning_item_id=li.id AND t.is_current
               ORDER BY t.is_primary DESC,t.id LIMIT 1) normalized_translation_text,
             COALESCE((SELECT sentence_text FROM product_gotit.item_occurrences o
               WHERE o.application_id=li.application_id AND o.application_user_id=li.application_user_id
                 AND o.learning_item_id=li.id AND o.learning_revision=li.learning_revision
                 AND o.sentence_text IS NOT NULL ORDER BY o.captured_at DESC,o.id LIMIT 1),
               (SELECT example_text FROM product_gotit.item_examples ex
                 WHERE ex.application_id=li.application_id AND ex.application_user_id=li.application_user_id
                   AND ex.learning_item_id=li.id AND ex.learning_revision=li.learning_revision
                 ORDER BY (ex.source_kind='user') DESC,ex.created_at,ex.id LIMIT 1)) context
           FROM product_gotit.learning_items li
           WHERE li.application_id=$1 AND li.application_user_id=$2 AND li.id=$3
             AND li.deleted_at IS NULL`,
          [...scopeValues(scope), itemId],
        )
      ).rows[0];
      if (!row || !row.translation_text)
        throw new AppError(409, 'ITEM_INCOMPLETE', 'Study item is unavailable or incomplete');
      return row;
    });
    const cachedImage =
      item.study_image_revision === item.learning_revision
        ? studyImageDto(
            item.study_image_data,
            item.study_image_content_type,
            item.source_text,
            item.translation_text,
            {
              kind: item.study_image_kind,
              provider: item.study_image_provider,
              sourceUrl: item.study_image_source_url,
              creator: item.study_image_creator,
            },
          )
        : null;
    if (cachedImage && item.study_image_model === this.imageProvider?.id)
      return {
        image: cachedImage,
      };
    if (!this.imageProvider) return { image: cachedImage };
    const shared = await withTransaction(this.pool, async (tx) => {
      const result = await tx.query(
        `UPDATE product_gotit.learning_items li
         SET study_image_data=asset.image_data,
             study_image_content_type=asset.image_content_type,
             study_image_model=asset.image_model,
             study_image_revision=li.learning_revision,
             study_image_kind=asset.image_kind,
             study_image_provider=asset.image_provider,
             study_image_source_url=asset.image_source_url,
             study_image_creator=asset.image_creator
         FROM (
           SELECT image_data,image_content_type,image_model,image_kind,image_provider,
                  image_source_url,image_creator
           FROM product_gotit.study_image_assets
           WHERE source_language_code=$4 AND normalized_source_text=$5
             AND translation_language_code=$6 AND normalized_translation_text=$7
             AND image_model=$8
           LIMIT 1
         ) asset
         WHERE li.application_id=$1 AND li.application_user_id=$2 AND li.id=$3
           AND li.learning_revision=$9 AND li.deleted_at IS NULL
         RETURNING asset.image_data,asset.image_content_type,asset.image_kind,
                   asset.image_provider,asset.image_source_url,asset.image_creator`,
        [
          ...scopeValues(scope),
          itemId,
          item.source_language_code,
          item.normalized_source_text,
          item.translation_language_code,
          item.normalized_translation_text,
          this.imageProvider!.id,
          item.learning_revision,
        ],
      );
      return result.rows[0];
    });
    if (shared)
      return {
        image: studyImageDto(
          shared.image_data,
          shared.image_content_type,
          item.source_text,
          item.translation_text,
          {
            kind: shared.image_kind,
            provider: shared.image_provider,
            sourceUrl: shared.image_source_url,
            creator: shared.image_creator,
          },
        ),
      };
    const generated = await this.imageProvider.generate({
      sourceText: item.source_text,
      translationText: item.translation_text,
      sourceLanguageCode: item.source_language_code,
      translationLanguageCode: item.translation_language_code,
      context: item.context,
    });
    if (!generated) return { image: cachedImage };
    const visual =
      generated.visual ??
      literalStudyImageBrief({
        sourceText: item.source_text,
        translationText: item.translation_text,
        sourceLanguageCode: item.source_language_code,
        translationLanguageCode: item.translation_language_code,
        context: item.context,
      });
    const stored = await withTransaction(this.pool, async (tx) => {
      const asset = (
        await tx.query(
          `INSERT INTO product_gotit.study_image_assets
             (source_language_code,normalized_source_text,translation_language_code,
              normalized_translation_text,image_model,sense_key,visual_brief,image_data,
              image_content_type,image_kind,image_provider,image_source_url,image_creator)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT
             (source_language_code,normalized_source_text,translation_language_code,
              normalized_translation_text,image_model)
           DO UPDATE SET image_model=EXCLUDED.image_model
           RETURNING image_data,image_content_type,image_kind,image_provider,
                     image_source_url,image_creator`,
          [
            item.source_language_code,
            item.normalized_source_text,
            item.translation_language_code,
            item.normalized_translation_text,
            this.imageProvider!.id,
            visual.senseKey,
            visual,
            generated.data,
            generated.contentType,
            generated.kind,
            generated.provider,
            generated.sourceUrl,
            generated.creator,
          ],
        )
      ).rows[0];
      if (!asset) throw new Error('Study image asset could not be stored');
      const result = await tx.query(
        `UPDATE product_gotit.learning_items
         SET study_image_data=$4,study_image_content_type=$5,study_image_model=$6,
             study_image_revision=learning_revision,study_image_kind=$8,
             study_image_provider=$9,study_image_source_url=$10,study_image_creator=$11
         WHERE application_id=$1 AND application_user_id=$2 AND id=$3
           AND learning_revision=$7 AND deleted_at IS NULL`,
        [
          ...scopeValues(scope),
          itemId,
          asset.image_data,
          asset.image_content_type,
          this.imageProvider!.id,
          item.learning_revision,
          asset.image_kind,
          asset.image_provider,
          asset.image_source_url,
          asset.image_creator,
        ],
      );
      return result.rowCount === 1 ? asset : null;
    });
    return {
      image: stored
        ? studyImageDto(
            stored.image_data,
            stored.image_content_type,
            item.source_text,
            item.translation_text,
            {
              kind: stored.image_kind,
              provider: stored.image_provider,
              sourceUrl: stored.image_source_url,
              creator: stored.image_creator,
            },
          )
        : null,
    };
  }
  async sessions(scope: ProfileScope, limit: number, cursor?: string) {
    return withTransaction(
      this.pool,
      async (tx) => {
        const totalCount = Number(
          (
            await tx.query(
              'SELECT count(*)::integer AS count FROM product_gotit.practice_sessions WHERE application_id=$1 AND application_user_id=$2',
              scopeValues(scope),
            )
          ).rows[0]?.count ?? 0,
        );
        const rows = (
          await tx.query(
            `SELECT session.* FROM product_gotit.practice_sessions session
             WHERE session.application_id=$1 AND session.application_user_id=$2
               AND ($3::uuid IS NULL OR (session.started_at,session.id)<(
                 SELECT cursor.started_at,cursor.id FROM product_gotit.practice_sessions cursor
                 WHERE cursor.application_id=$1 AND cursor.application_user_id=$2 AND cursor.id=$3
               ))
             ORDER BY session.started_at DESC,session.id DESC LIMIT $4`,
            [...scopeValues(scope), cursor ?? null, limit + 1],
          )
        ).rows;
        return {
          items: rows.slice(0, limit).map((r) => this.sessionDto(r)),
          nextCursor: rows.length > limit ? rows[limit - 1]!.id : null,
          totalCount,
        };
      },
      true,
    );
  }
  async closeSession(scope: ProfileScope, id: string, status: 'completed' | 'abandoned') {
    const profile = await this.profiles.getProfile(scope);
    return withTransaction(this.pool, async (tx) => {
      await tx.lock(['practice-user', ...scopeValues(scope)]);
      const row = await this.session(tx, scope, id);
      if (row.status !== 'active') {
        if (row.status !== status)
          throw new AppError(409, 'SESSION_CLOSED', 'Session already closed');
        return this.sessionDto(row);
      }
      const now = (await tx.query('SELECT clock_timestamp() AS timestamp')).rows[0]!
          .timestamp as Date,
        day = calendarDay(now, profile.timezone);
      let reward = 0;
      if (status === 'completed' && row.attempt_count >= 3) {
        const meaningful = await tx.query(
          `SELECT count(*)::integer count FROM product_gotit.practice_attempts WHERE application_id=$1 AND application_user_id=$2 AND practice_session_id=$3 AND result NOT IN('skipped','incorrect')`,
          [...scopeValues(scope), id],
        );
        if (meaningful.rows[0]!.count >= 3)
          reward = await this.award(
            tx,
            scope,
            `session:${id}`,
            'session',
            id,
            this.policy.sessionXp,
            day,
            profile.timezone,
            now,
          );
      }
      const duration = Math.max(
        0,
        Math.min(
          7200,
          Math.floor((now.getTime() - (row.started_at ?? row.created_at).getTime()) / 1000),
        ),
      );
      const updated = (
        await tx.query(
          `UPDATE product_gotit.practice_sessions SET status=$4,ended_at=$5,duration_seconds=$6,xp_earned=xp_earned+$7,updated_at=now() WHERE application_id=$1 AND application_user_id=$2 AND id=$3 RETURNING *`,
          [...scopeValues(scope), id, status, now, duration, reward],
        )
      ).rows[0]!;
      if (status === 'completed') {
        await tx.query(
          `INSERT INTO product_gotit.user_daily_activity(application_id,application_user_id,activity_date,sessions_completed,xp_earned) VALUES($1,$2,$3,1,$4)
      ON CONFLICT(application_id,application_user_id,activity_date) DO UPDATE SET sessions_completed=product_gotit.user_daily_activity.sessions_completed+1,xp_earned=product_gotit.user_daily_activity.xp_earned+EXCLUDED.xp_earned`,
          [...scopeValues(scope), day, reward],
        );
      }
      return this.sessionDto(updated);
    });
  }
  async issueExercises(scope: ProfileScope, id: string, input: ExercisesInput) {
    const profile = await this.profiles.getProfile(scope);
    return withTransaction(this.pool, async (tx) => {
      const session = await this.session(tx, scope, id);
      if (session.status !== 'active')
        throw new AppError(409, 'SESSION_CLOSED', 'Session is closed');
      const open = await tx.query(
        `SELECT count(*)::integer count FROM product_gotit.practice_exercises WHERE application_id=$1 AND application_user_id=$2 AND practice_session_id=$3 AND consumed_at IS NULL AND expires_at>now()`,
        [...scopeValues(scope), id],
      );
      if (open.rows[0]!.count + input.count > 100)
        throw new AppError(409, 'EXERCISE_LIMIT', 'Finish outstanding exercises first');
      const sessionIds = session.selection.itemIds as string[];
      const ids = input.learningItemIds ?? sessionIds;
      if (ids.some((itemId) => !sessionIds.includes(itemId)))
        throw new AppError(
          400,
          'VALIDATION_ERROR',
          'Requested exercise item is outside the session selection',
        );
      const issuedCount = (
        await tx.query(
          'SELECT count(*)::integer count FROM product_gotit.practice_exercises WHERE application_id=$1 AND application_user_id=$2 AND practice_session_id=$3',
          [...scopeValues(scope), id],
        )
      ).rows[0]!.count;
      let readingBody: string | null = null;
      if (session.session_type === 'article_quiz') {
        const content = (
          await tx.query(
            'SELECT body_text FROM product_gotit.generated_contents WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL',
            [...scopeValues(scope), session.selection.readingId],
          )
        ).rows[0];
        if (!content) throw new AppError(409, 'READING_UNAVAILABLE', 'Reading was deleted');
        readingBody = content.body_text;
      }
      const rows = (
        await tx.query(
          `SELECT li.*,ARRAY(SELECT translation_text FROM product_gotit.item_translations t WHERE t.application_id=li.application_id AND t.application_user_id=li.application_user_id AND t.learning_item_id=li.id AND t.is_current ORDER BY is_primary DESC,id) translations,
      COALESCE((SELECT sentence_text FROM product_gotit.item_occurrences o WHERE o.application_id=li.application_id AND o.application_user_id=li.application_user_id AND o.learning_item_id=li.id AND o.learning_revision=li.learning_revision AND sentence_text IS NOT NULL ORDER BY captured_at DESC,id LIMIT 1),
        (SELECT example_text FROM product_gotit.item_examples ex WHERE ex.application_id=li.application_id AND ex.application_user_id=li.application_user_id AND ex.learning_item_id=li.id AND ex.learning_revision=li.learning_revision ORDER BY (ex.source_kind='user') DESC,ex.created_at,ex.id LIMIT 1)) context
      FROM product_gotit.learning_items li WHERE application_id=$1 AND application_user_id=$2 AND id=ANY($3::uuid[]) AND deleted_at IS NULL ORDER BY next_review_at NULLS LAST,created_at,id`,
          [...scopeValues(scope), ids],
        )
      ).rows;
      if (!rows.length) throw new AppError(409, 'NO_ELIGIBLE_ITEMS', 'No eligible learning items');
      const choiceRows =
        session.session_type === 'smart_review'
          ? [
              ...rows,
              ...(
                await tx.query(
                  `SELECT li.*,ARRAY(SELECT translation_text FROM product_gotit.item_translations t
                    WHERE t.application_id=li.application_id
                      AND t.application_user_id=li.application_user_id
                      AND t.learning_item_id=li.id AND t.is_current
                    ORDER BY is_primary DESC,id) translations
                   FROM product_gotit.learning_items li
                   WHERE li.application_id=$1 AND li.application_user_id=$2
                     AND NOT(li.id=ANY($3::uuid[]))
                     AND li.user_status='active' AND li.deleted_at IS NULL
                     AND EXISTS(SELECT 1 FROM product_gotit.learning_items target
                       WHERE target.application_id=li.application_id
                         AND target.application_user_id=li.application_user_id
                         AND target.id=ANY($3::uuid[])
                         AND target.source_language_code=li.source_language_code
                         AND target.translation_language_code=li.translation_language_code)
                   ORDER BY li.created_at,id LIMIT 50`,
                  [...scopeValues(scope), ids],
                )
              ).rows,
            ]
          : rows;
      const matching = (input.exerciseType ?? session.session_type) === 'matching';
      const matchingReverse = input.direction === 'translation_to_source';
      let exerciseRows = rows;
      const matchingChoices: { id: string; text: string }[] = [];
      const groupId = matching ? randomUUID() : undefined;
      if (matching) {
        if (input.count < 2)
          throw new AppError(400, 'MATCHING_GROUP_SIZE', 'Matching requires at least two cards');
        exerciseRows = [];
        for (
          let offset = 0;
          offset < rows.length && exerciseRows.length < Math.min(input.count, 6);
          offset++
        ) {
          const candidate = rows[(issuedCount + offset) % rows.length]!;
          const answer = matchingReverse ? candidate.source_text : candidate.translations[0];
          if (
            answer &&
            !matchingChoices.some((choice) => lookupText(choice.text) === lookupText(answer))
          ) {
            exerciseRows.push(candidate);
            matchingChoices.push({ id: randomUUID(), text: answer });
          }
        }
        if (exerciseRows.length < 2)
          throw new AppError(
            409,
            'INSUFFICIENT_DISTRACTORS',
            'Matching requires distinct owned expressions and meanings',
          );
        for (let i = matchingChoices.length - 1; i > 0; i--) {
          const j = randomInt(i + 1);
          [matchingChoices[i], matchingChoices[j]] = [matchingChoices[j]!, matchingChoices[i]!];
        }
      }
      const exercises = [];
      for (let index = 0; index < (matching ? exerciseRows.length : input.count); index++) {
        const row = matching ? exerciseRows[index]! : rows[(issuedCount + index) % rows.length]!,
          translations = row.translations as string[];
        if (!translations.length)
          throw new AppError(409, 'ITEM_INCOMPLETE', 'Learning item has no accepted translation');
        let type = input.exerciseType ?? session.session_type,
          masteryGateRecall = false;
        if (type === 'manual' && !input.exerciseType)
          throw new AppError(400, 'VALIDATION_ERROR', 'Manual session requires an exercise type');
        if (type === 'smart_review') {
          const activeRecall = (
              await tx.query(
                `WITH history AS(
                   SELECT a.score::float8 score,(a.created_at AT TIME ZONE $4)::date AS activity_day,a.created_at,a.id
                   FROM product_gotit.practice_attempts a
                   WHERE a.application_id=$1 AND a.application_user_id=$2 AND a.learning_item_id=$3
                     AND a.result<>'skipped' AND a.user_answer_text IS NOT NULL
                     AND COALESCE(a.learning_revision,1)=$5
                     AND EXISTS(SELECT 1 FROM product_gotit.attempt_skill_effects e
                       WHERE e.practice_attempt_id=a.id AND e.skill_type='recall'))
                 SELECT count(*) FILTER(WHERE score>=85)::integer successes,
                   count(DISTINCT activity_day) FILTER(WHERE score>=85)::integer successful_days,
                   COALESCE(bool_or(activity_day=(now() AT TIME ZONE $4)::date AND score>=85),false) successful_today,
                   (SELECT count(*)::integer FROM product_gotit.practice_attempts total
                     WHERE total.application_id=$1 AND total.application_user_id=$2
                       AND total.learning_item_id=$3 AND total.result<>'skipped'
                       AND COALESCE(total.learning_revision,1)=$5) total_scored_attempts,
                   ARRAY(SELECT DISTINCT total.exercise_type
                     FROM product_gotit.practice_attempts total
                     WHERE total.application_id=$1 AND total.application_user_id=$2
                       AND total.learning_item_id=$3 AND total.result<>'skipped'
                       AND total.score>=85
                       AND COALESCE(total.learning_revision,1)=$5) mastered_exercise_types,
                   ARRAY(SELECT score FROM(SELECT score,created_at,id FROM history
                     ORDER BY created_at DESC,id DESC LIMIT 10) recent ORDER BY created_at,id) scores
                 FROM history`,
                [...scopeValues(scope), row.id, profile.timezone, row.learning_revision],
              )
            ).rows[0]!,
            totalScoredAttempts = Number(activeRecall.total_scored_attempts),
            recallMastery = projectEvidence(
              activeRecall.scores,
              activeRecall.successful_days,
            ).masteryScore,
            available = this.availableSkills(profile, row.source_language_code),
            distinctMeanings = new Set(
              choiceRows
                .filter(
                  (candidate) =>
                    candidate.source_language_code === row.source_language_code &&
                    candidate.translation_language_code === row.translation_language_code,
                )
                .map((candidate) => candidate.translations[0] as string | undefined)
                .filter((translation): translation is string => Boolean(translation))
                .map(lookupText),
            ).size,
            introductoryType = nextSmartLearningExercise(
              available,
              activeRecall.mastered_exercise_types,
              rows.length >= 2 && distinctMeanings >= 2,
            ),
            hasMasteryGap =
              row.learning_status !== 'mastered' &&
              (totalScoredAttempts < this.policy.minimumScoredAttempts ||
                activeRecall.successes < this.policy.minimumActiveRecallSuccesses ||
                activeRecall.successful_days < this.policy.minimumActiveRecallCalendarDays ||
                recallMastery < this.policy.masteryThreshold ||
                row.review_stage < LEARNED_REVIEW_STAGE);
          // A qualifying recall can advance maturity at most once per profile-calendar day.
          // Introduce a word gradually before asking for active recall. Once the
          // introduction is complete, prefer a qualifying recall over optional
          // weak skills only when it can make progress now.
          if (introductoryType) type = introductoryType;
          else {
            masteryGateRecall = hasMasteryGap && !activeRecall.successful_today;
            const weakest = (
              await tx.query(
                'SELECT skill_type FROM product_gotit.item_skill_progress WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3 AND skill_type=ANY($4::text[]) ORDER BY mastery_score,attempt_count,skill_type LIMIT 1',
                [...scopeValues(scope), row.id, available],
              )
            ).rows[0]?.skill_type;
            type = masteryGateRecall
              ? 'recall'
              : weakest === 'recognition'
                ? 'flashcards'
                : weakest === 'listening'
                  ? 'listening_spelling'
                  : weakest === 'pronunciation'
                    ? 'pronunciation'
                    : 'recall';
          }
        }
        if (
          session.session_type !== 'smart_review' &&
          session.session_type !== 'manual' &&
          type !== session.session_type
        )
          throw new AppError(400, 'VALIDATION_ERROR', 'Exercise type does not match session');
        const reverse =
          session.session_type === 'smart_review'
            ? type === 'recall' || type === 'listening_spelling'
            : masteryGateRecall
              ? true
              : type === 'pronunciation'
                ? false
                : type === 'listening_spelling'
                  ? true
                  : input.direction === 'translation_to_source' ||
                    (input.direction === undefined && type !== 'flashcards' && type !== 'matching');
        const direction = reverse ? 'translation_to_source' : 'source_to_translation';
        const accepted =
          type === 'pronunciation' ? [row.source_text] : reverse ? [row.source_text] : translations;
        let kind: AnswerSpec['kind'] = masteryGateRecall
          ? 'typed'
          : type === 'flashcards'
            ? 'self_rating'
            : type === 'pronunciation'
              ? 'provider'
              : type === 'matching' || input.kind === 'multiple_choice'
                ? 'multiple_choice'
                : 'typed';
        let skills: AnswerSpec['skills'] =
          type === 'flashcards'
            ? [{ skill: reverse ? 'recall' : 'recognition', weight: 1 }]
            : type === 'listening_spelling'
              ? [
                  { skill: 'listening', weight: 1 },
                  { skill: 'spelling', weight: 1 },
                ]
              : type === 'pronunciation'
                ? [{ skill: 'pronunciation', weight: 1 }]
                : type === 'matching'
                  ? [{ skill: reverse ? 'recall' : 'recognition', weight: 1 }]
                  : [
                      { skill: reverse ? 'recall' : 'recognition', weight: 1 },
                      ...(kind === 'typed' && reverse
                        ? [{ skill: 'spelling' as const, weight: 0.5 }]
                        : []),
                    ];
        const enabled = this.availableSkills(profile, row.source_language_code);
        skills = skills.filter((s) => enabled.includes(s.skill));
        const requiredSpeechSkill =
          type === 'listening_spelling'
            ? 'listening'
            : type === 'pronunciation'
              ? 'pronunciation'
              : null;
        if (
          !skills.length ||
          (requiredSpeechSkill !== null && !enabled.includes(requiredSpeechSkill)) ||
          (['listening_spelling', 'pronunciation'].includes(type) &&
            !this.speechAvailable(
              row.source_language_code,
              type === 'pronunciation' ? 'pronunciation' : 'listening',
            ))
        )
          throw new AppError(503, 'SKILL_UNAVAILABLE', 'Exercise skill is not enabled/configured');
        const prompt: Record<string, unknown> = {
          text: type === 'listening_spelling' ? null : reverse ? translations[0] : row.source_text,
          languageCode: reverse ? row.translation_language_code : row.source_language_code,
          context:
            type === 'listening_spelling'
              ? null
              : type === 'flashcards'
                ? row.context
                : hideAnswers(readingBody ?? row.context, accepted),
          ...(kind === 'typed' || type === 'pronunciation'
            ? {
                ...(type === 'listening_spelling' || type === 'pronunciation'
                  ? { audioUrl: `/api/v1/learning-items/${row.id}/audio` }
                  : {}),
                letterCount: [...accepted[0]!].length,
                wordLengths: answerWordLengths(accepted[0]!),
              }
            : {}),
          ...(type === 'flashcards' ? { answer: accepted[0] } : {}),
          ...(matching ? { groupId } : {}),
        };
        const spec: AnswerSpec = { kind, accepted, skills };
        if (matching) {
          prompt.choices = matchingChoices;
          spec.choices = matchingChoices.map((choice) => ({
            id: choice.id,
            correct: lookupText(choice.text) === lookupText(accepted[0]!),
          }));
        } else if (kind === 'multiple_choice') {
          const choices = [{ id: randomUUID(), text: accepted[0]!, correct: true }];
          for (const other of choiceRows) {
            if (
              other.source_language_code !== row.source_language_code ||
              other.translation_language_code !== row.translation_language_code
            )
              continue;
            const text = reverse ? other.source_text : other.translations[0];
            if (
              text &&
              !choices.some((c) => lookupText(c.text) === lookupText(text)) &&
              !accepted.some((a) => lookupText(a) === lookupText(text))
            )
              choices.push({ id: randomUUID(), text, correct: false });
            if (choices.length === 4) break;
          }
          if (choices.length < 2)
            throw new AppError(
              409,
              'INSUFFICIENT_DISTRACTORS',
              'Choose typed practice or add distinct items',
            );
          for (let i = choices.length - 1; i > 0; i--) {
            const j = randomInt(i + 1);
            [choices[i], choices[j]] = [choices[j]!, choices[i]!];
          }
          prompt.choices = choices.map(({ correct, ...choice }) => choice);
          spec.choices = choices.map(({ id, correct }) => ({ id, correct }));
        }
        const exerciseId = randomUUID(),
          expiresAt = new Date(Date.now() + 30 * 60000);
        await tx.query(
          `INSERT INTO product_gotit.practice_exercises(id,application_id,application_user_id,practice_session_id,learning_item_id,exercise_type,prompt_direction,prompt,answer_spec,item_snapshot_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            exerciseId,
            ...scopeValues(scope),
            id,
            row.id,
            type,
            direction,
            JSON.stringify(prompt),
            JSON.stringify(spec),
            itemSnapshot(row, translations),
            expiresAt,
          ],
        );
        exercises.push({
          id: exerciseId,
          learningItemId: row.id,
          exerciseType: type,
          kind,
          direction,
          prompt,
          expiresAt,
        });
      }
      if (session.session_type === 'smart_review') {
        const rank = new Map(SMART_LEARNING_ORDER.map((type, index) => [type, index]));
        exercises.sort(
          (left, right) =>
            (rank.get(left.exerciseType as ExerciseType) ?? SMART_LEARNING_ORDER.length) -
            (rank.get(right.exerciseType as ExerciseType) ?? SMART_LEARNING_ORDER.length),
        );
      }
      return {
        exercises,
        ...(matching ? { matchingGroup: { id: groupId, choices: matchingChoices } } : {}),
        algorithmVersion: this.version,
      };
    });
  }
  async submitAttempt(
    scope: ProfileScope,
    key: string,
    input: AttemptInput,
    verifiedAssessment?: {
      score: number;
      summary: string;
      feedback?: string;
      exerciseId: string;
      requestHash?: string;
    },
  ) {
    const profile = await this.profiles.getProfile(scope),
      hash = verifiedAssessment?.requestHash ?? fingerprint(input);
    return withTransaction(this.pool, async (tx) => {
      await tx.lock(['practice-user', ...scopeValues(scope)]);
      await tx.lock(['practice-attempt-event', ...scopeValues(scope), key]);
      const prior = (
        await tx.query(
          'SELECT id,request_hash,response_receipt FROM product_gotit.practice_attempts WHERE application_id=$1 AND application_user_id=$2 AND client_event_id=$3',
          [...scopeValues(scope), key],
        )
      ).rows[0];
      if (prior) {
        if (!prior.request_hash || !prior.response_receipt)
          throw new AppError(409, 'IDEMPOTENCY_LEGACY_EVENT', 'Historical attempt has no receipt');
        if (prior.request_hash !== hash)
          throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Attempt event key was reused');
        const parsed = attemptReceiptSchema.safeParse(prior.response_receipt);
        if (
          !parsed.success ||
          parsed.data.requestHash !== hash ||
          parsed.data.data.attempt.id !== prior.id
        )
          throw new AppError(500, 'INTERNAL_ERROR', 'Invalid attempt receipt');
        return { ...parsed.data.data, replayed: true };
      }
      const initial = (
        await tx.query(
          'SELECT practice_session_id FROM product_gotit.practice_exercises WHERE application_id=$1 AND application_user_id=$2 AND id=$3',
          [...scopeValues(scope), input.exerciseId],
        )
      ).rows[0];
      if (!initial) throw new AppError(404, 'NOT_FOUND', 'Exercise not found');
      const session = await this.session(tx, scope, initial.practice_session_id);
      if (session.status !== 'active')
        throw new AppError(409, 'SESSION_CLOSED', 'Session is closed');
      const exercise = (
        await tx.query(
          'SELECT * FROM product_gotit.practice_exercises WHERE application_id=$1 AND application_user_id=$2 AND id=$3 FOR UPDATE',
          [...scopeValues(scope), input.exerciseId],
        )
      ).rows[0]!;
      if (exercise.consumed_at)
        throw new AppError(409, 'EXERCISE_CONSUMED', 'Exercise already submitted');
      if (exercise.expires_at.getTime() <= Date.now())
        throw new AppError(409, 'EXERCISE_EXPIRED', 'Exercise expired');
      const item = (
        await tx.query(
          'SELECT * FROM product_gotit.learning_items WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL FOR UPDATE',
          [...scopeValues(scope), exercise.learning_item_id],
        )
      ).rows[0];
      if (!item) throw itemNotFound();
      const translations = (
        await tx.query(
          'SELECT translation_text FROM product_gotit.item_translations WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3 AND is_current ORDER BY is_primary DESC,id',
          [...scopeValues(scope), item.id],
        )
      ).rows.map((r) => r.translation_text);
      if (
        item.user_status !== 'active' ||
        exercise.item_snapshot_hash !== itemSnapshot(item, translations)
      )
        throw new AppError(
          409,
          'EXERCISE_STALE',
          'Learning item changed; request another exercise',
        );
      const spec = exercise.answer_spec as AnswerSpec,
        now = (await tx.query('SELECT clock_timestamp() AS timestamp')).rows[0]!.timestamp as Date,
        day = calendarDay(now, profile.timezone);
      const scored =
        spec.kind === 'provider' &&
        verifiedAssessment &&
        verifiedAssessment.exerciseId === exercise.id
          ? {
              score: verifiedAssessment.score,
              result:
                verifiedAssessment.score >= 85
                  ? 'correct'
                  : verifiedAssessment.score >= 50
                    ? 'partially_correct'
                    : 'incorrect',
              expectedAnswer: item.source_text,
            }
          : scoreAnswer(spec, input);
      const attemptId = randomUUID(),
        sequence = session.attempt_count + 1;
      await tx.query(
        `INSERT INTO product_gotit.practice_attempts(id,application_id,application_user_id,practice_session_id,learning_item_id,exercise_type,prompt_direction,result,score,user_answer_text,expected_answer_text,response_time_ms,hints_used,self_rating,attempt_sequence,client_event_id,algorithm_version,request_hash,learning_revision,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
        [
          attemptId,
          ...scopeValues(scope),
          session.id,
          item.id,
          exercise.exercise_type,
          exercise.prompt_direction,
          scored.result,
          scored.score,
          verifiedAssessment?.summary ?? input.answerText ?? null,
          scored.expectedAnswer,
          input.responseTimeMs ?? null,
          input.hintsUsed,
          input.selfRating ?? null,
          sequence,
          key,
          this.version,
          hash,
          item.learning_revision,
          now,
        ],
      );
      const enabled = this.availableSkills(profile, item.source_language_code);
      if (!input.skipped && !spec.skills.some((e) => enabled.includes(e.skill)))
        throw new AppError(409, 'SKILL_CHANGED', 'Exercise skill is no longer enabled');
      if (!input.skipped)
        for (const effect of spec.skills.filter((e) => enabled.includes(e.skill))) {
          await tx.query(
            'INSERT INTO product_gotit.attempt_skill_effects(practice_attempt_id,skill_type,quality_score,weight) VALUES($1,$2,$3,$4)',
            [attemptId, effect.skill, scored.score, effect.weight],
          );
        }
      const evidence: Evidence[] = [];
      for (const skill of enabled) {
        const aggregate = (
          await tx.query(
            `WITH history AS(
        SELECT e.quality_score::float8 score,(a.created_at AT TIME ZONE $5)::date AS activity_day,a.created_at,a.id
        FROM product_gotit.attempt_skill_effects e JOIN product_gotit.practice_attempts a ON a.id=e.practice_attempt_id
        WHERE a.application_id=$1 AND a.application_user_id=$2 AND a.learning_item_id=$3 AND e.skill_type=$4 AND COALESCE(a.learning_revision,1)=$6)
        SELECT count(*)::integer AS attempts,count(*) FILTER(WHERE score>=85)::integer AS successes,count(*) FILTER(WHERE score<50)::integer AS failures,
          count(DISTINCT activity_day)::integer AS days,max(created_at) last_attempt,max(created_at) FILTER(WHERE score>=85) last_success,max(created_at) FILTER(WHERE score<50) last_failure,
          ARRAY(SELECT score FROM(SELECT score,created_at,id FROM history ORDER BY created_at DESC,id DESC LIMIT 10) r ORDER BY created_at,id) scores FROM history`,
            [...scopeValues(scope), item.id, skill, profile.timezone, item.learning_revision],
          )
        ).rows[0]!;
        const projection = projectEvidence(aggregate.scores, aggregate.days, {
          attemptCount: aggregate.attempts,
          successCount: aggregate.successes,
          failureCount: aggregate.failures,
        });
        evidence.push({ skillType: skill, ...projection });
        if (!input.skipped)
          await tx.query(
            `INSERT INTO product_gotit.item_skill_progress(application_id,application_user_id,learning_item_id,skill_type,mastery_score,confidence,attempt_count,success_count,failure_count,last_attempt_at,last_success_at,last_failure_at,algorithm_version)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(learning_item_id,skill_type) DO UPDATE SET mastery_score=EXCLUDED.mastery_score,confidence=EXCLUDED.confidence,attempt_count=EXCLUDED.attempt_count,success_count=EXCLUDED.success_count,failure_count=EXCLUDED.failure_count,last_attempt_at=EXCLUDED.last_attempt_at,last_success_at=EXCLUDED.last_success_at,last_failure_at=EXCLUDED.last_failure_at,algorithm_version=EXCLUDED.algorithm_version,updated_at=now()`,
            [
              ...scopeValues(scope),
              item.id,
              skill,
              projection.masteryScore,
              projection.confidence,
              projection.attemptCount,
              projection.successCount,
              projection.failureCount,
              aggregate.last_attempt,
              aggregate.last_success,
              aggregate.last_failure,
              this.version,
            ],
          );
      }
      const activeRecall = (
        await tx.query(
          `WITH history AS(
          SELECT a.id,a.score::float8 score,(a.created_at AT TIME ZONE $4)::date AS activity_day,a.created_at
          FROM product_gotit.practice_attempts a
          WHERE a.application_id=$1 AND a.application_user_id=$2 AND a.learning_item_id=$3
            AND a.result<>'skipped' AND a.user_answer_text IS NOT NULL AND COALESCE(a.learning_revision,1)=$5
            AND EXISTS(SELECT 1 FROM product_gotit.attempt_skill_effects e WHERE e.practice_attempt_id=a.id AND e.skill_type='recall'))
          SELECT count(*)::integer attempts,count(*) FILTER(WHERE score>=85)::integer successes,
            count(DISTINCT activity_day) FILTER(WHERE score>=85)::integer successful_days,
            count(*) FILTER(WHERE score<50)::integer failures,
            max(created_at) FILTER(WHERE id<>$6 AND score>=85) previous_success,
            ARRAY(SELECT score FROM(SELECT score,created_at,id FROM history ORDER BY created_at DESC,id DESC LIMIT 10) r ORDER BY created_at,id) scores,
            ARRAY(SELECT score FROM(SELECT score,created_at,id FROM history ORDER BY created_at DESC,id DESC LIMIT 3) r ORDER BY created_at,id) recent_scores
          FROM history`,
          [...scopeValues(scope), item.id, profile.timezone, item.learning_revision, attemptId],
        )
      ).rows[0]!;
      const totalScoredAttempts = Number(
        (
          await tx.query(
            `SELECT count(*)::integer count FROM product_gotit.practice_attempts
             WHERE application_id=$1 AND application_user_id=$2 AND learning_item_id=$3
               AND result<>'skipped' AND COALESCE(learning_revision,1)=$4`,
            [...scopeValues(scope), item.id, item.learning_revision],
          )
        ).rows[0]!.count,
      );
      const activeRecallProjection = projectEvidence(
          activeRecall.scores,
          activeRecall.successful_days,
          {
            attemptCount: activeRecall.attempts,
            successCount: activeRecall.successes,
            failureCount: activeRecall.failures,
          },
        ),
        masteryEvidence: MasteryEvidence = {
          totalScoredAttempts,
          activeRecallSuccesses: activeRecall.successes,
          activeRecallCalendarDays: activeRecall.successful_days,
          activeRecallMasteryScore: activeRecallProjection.masteryScore,
        },
        activeRecallAttempt =
          input.answerText !== undefined && spec.skills.some((e) => e.skill === 'recall'),
        // Repetition on the same profile-calendar day cannot advance review maturity.
        canAdvance =
          !activeRecall.previous_success ||
          calendarDay(activeRecall.previous_success, profile.timezone) !== day;
      const progress = input.skipped
        ? {
            status: item.learning_status,
            stage: item.review_stage,
            masterySource: item.mastery_source,
            masteryScore: Number(item.overall_mastery_score),
            retentionLevel: retentionLevelFor(item.learning_status, item.review_stage),
            masteryRequirements: masteryRequirements(
              this.policy,
              masteryEvidence,
              item.review_stage,
              item.learning_status,
            ),
            nextReviewAt: item.next_review_at,
          }
        : decideProgress(
            this.policy,
            masteryEvidence,
            {
              status: item.learning_status,
              stage: item.review_stage,
              masterySource: item.mastery_source,
            },
            scored.score,
            now,
            activeRecall.recent_scores,
            activeRecallAttempt,
            canAdvance,
            projectOverallMastery(this.policy, evidence),
          );
      // Optional skills remain useful evidence, but they must not postpone the
      // active-recall review that is required to finish learning the item.
      if (!input.skipped && !activeRecallAttempt && item.learning_status !== 'mastered')
        progress.nextReviewAt = item.next_review_at ?? now;
      if (!input.skipped)
        await tx.query(
          `UPDATE product_gotit.learning_items SET overall_mastery_score=$4,learning_status=$5,review_stage=$6,next_review_at=$7,mastery_source=$8,last_practiced_at=$9,system_difficulty=$10,
        first_mastered_at=CASE WHEN $5='mastered' THEN COALESCE(first_mastered_at,$9) ELSE first_mastered_at END,last_mastered_at=CASE WHEN $5='mastered' THEN $9 ELSE last_mastered_at END,updated_at=clock_timestamp()
        WHERE application_id=$1 AND application_user_id=$2 AND id=$3`,
          [
            ...scopeValues(scope),
            item.id,
            progress.masteryScore,
            progress.status,
            progress.stage,
            progress.nextReviewAt,
            progress.masterySource,
            now,
            Math.round((1 - progress.masteryScore / 100) * 10000) / 10000,
          ],
        );
      if (progress.status !== item.learning_status || progress.stage !== item.review_stage)
        await tx.query(
          `INSERT INTO product_gotit.learning_algorithm_events(application_id,application_user_id,learning_item_id,event_type,from_status,to_status,from_stage,to_stage,reason_code,algorithm_version)
        VALUES($1,$2,$3,'attempt_projection',$4,$5,$6,$7,'scored_evidence',$8)`,
          [
            ...scopeValues(scope),
            item.id,
            item.learning_status,
            progress.status,
            item.review_stage,
            progress.stage,
            this.version,
          ],
        );
      let reward = input.skipped
        ? 0
        : scored.result === 'correct'
          ? this.policy.correctXp
          : scored.result === 'partially_correct'
            ? this.policy.partialXp
            : scored.result === 'self_rated' && scored.score >= 85
              ? this.policy.selfRatedXp
              : 0;
      reward = await this.award(
        tx,
        scope,
        `attempt:${day}:${item.id}:${exercise.exercise_type}`,
        'attempt',
        attemptId,
        reward,
        day,
        profile.timezone,
        now,
      );
      if (
        progress.status === 'mastered' &&
        item.learning_status !== 'mastered' &&
        progress.masterySource === 'system'
      )
        reward += await this.award(
          tx,
          scope,
          `mastery:${item.id}:${item.learning_revision}`,
          'mastery',
          item.id,
          this.policy.masteryXp,
          day,
          profile.timezone,
          now,
        );
      if (!input.skipped) await this.recordActivity(tx, scope, day);
      const previousAttempt =
        (
          await tx.query(
            'SELECT created_at FROM product_gotit.practice_attempts WHERE application_id=$1 AND application_user_id=$2 AND practice_session_id=$3 AND id<>$4 ORDER BY attempt_sequence DESC LIMIT 1',
            [...scopeValues(scope), session.id, attemptId],
          )
        ).rows[0]?.created_at ?? session.started_at;
      const elapsed = input.skipped
        ? 0
        : Math.max(
            0,
            Math.min(120, Math.floor((now.getTime() - previousAttempt.getTime()) / 1000)),
          );
      await tx.query(
        `INSERT INTO product_gotit.user_daily_activity(application_id,application_user_id,activity_date,practice_seconds,attempts,correct_attempts,xp_earned)
        VALUES($1,$2,$3,$4,1,$5,$6) ON CONFLICT(application_id,application_user_id,activity_date) DO UPDATE SET practice_seconds=product_gotit.user_daily_activity.practice_seconds+EXCLUDED.practice_seconds,attempts=product_gotit.user_daily_activity.attempts+1,correct_attempts=product_gotit.user_daily_activity.correct_attempts+EXCLUDED.correct_attempts,xp_earned=product_gotit.user_daily_activity.xp_earned+EXCLUDED.xp_earned`,
        [...scopeValues(scope), day, elapsed, scored.score >= 85 && !input.skipped ? 1 : 0, reward],
      );
      const activity = (
        await tx.query(
          `SELECT practice_seconds,xp_earned,(SELECT count(*)::integer FROM product_gotit.practice_attempts WHERE application_id=$1 AND application_user_id=$2 AND (created_at AT TIME ZONE $4)::date=$3::date AND result<>'skipped') attempts,(SELECT count(DISTINCT learning_item_id)::integer FROM product_gotit.practice_attempts WHERE application_id=$1 AND application_user_id=$2 AND (created_at AT TIME ZONE $4)::date=$3::date AND result<>'skipped') items FROM product_gotit.user_daily_activity WHERE application_id=$1 AND application_user_id=$2 AND activity_date=$3`,
          [...scopeValues(scope), day, profile.timezone],
        )
      ).rows[0]!;
      if (!input.skipped)
        await tx.query(
          `UPDATE product_gotit.user_daily_activity SET items_practiced=$4,items_mastered=(SELECT count(*)::integer FROM product_gotit.learning_items WHERE application_id=$1 AND application_user_id=$2 AND (first_mastered_at AT TIME ZONE $5)::date=$3::date),updated_at=now() WHERE application_id=$1 AND application_user_id=$2 AND activity_date=$3`,
          [...scopeValues(scope), day, activity.items, profile.timezone],
        );
      const goalValue =
        profile.dailyGoal.type === 'minutes'
          ? Math.floor(activity.practice_seconds / 60)
          : profile.dailyGoal.type === 'items'
            ? activity.items
            : activity.attempts;
      let todayXp = Number(activity.xp_earned);
      if (!input.skipped && goalValue >= profile.dailyGoal.value) {
        const goalXp = await this.award(
          tx,
          scope,
          `goal:${day}`,
          'daily_goal',
          null,
          this.policy.dailyGoalXp,
          day,
          profile.timezone,
          now,
        );
        reward += goalXp;
        todayXp += goalXp;
        if (goalXp)
          await tx.query(
            'UPDATE product_gotit.user_daily_activity SET xp_earned=xp_earned+$4 WHERE application_id=$1 AND application_user_id=$2 AND activity_date=$3',
            [...scopeValues(scope), day, goalXp],
          );
      }
      const dailyXpRemaining = Math.max(0, this.policy.dailyXpCap - todayXp);
      await tx.query(
        'UPDATE product_gotit.practice_sessions SET attempt_count=$4,correct_count=correct_count+$5,xp_earned=xp_earned+$6,updated_at=now() WHERE application_id=$1 AND application_user_id=$2 AND id=$3',
        [
          ...scopeValues(scope),
          session.id,
          sequence,
          scored.score >= 85 && !input.skipped ? 1 : 0,
          reward,
        ],
      );
      await tx.query(
        'UPDATE product_gotit.practice_exercises SET consumed_at=$4 WHERE application_id=$1 AND application_user_id=$2 AND id=$3',
        [...scopeValues(scope), exercise.id, now],
      );
      const data = {
        attempt: {
          id: attemptId,
          learningItemId: item.id,
          sessionId: session.id,
          sequence,
          result: scored.result,
          score: scored.score,
          expectedAnswer: scored.expectedAnswer,
          xpEarned: reward,
          xpStatus: {
            todayXp,
            dailyXpCap: this.policy.dailyXpCap,
            dailyXpRemaining,
            dailyXpCapReached: dailyXpRemaining === 0,
            postDailyCapPercent: this.policy.postDailyCapPercent,
          },
          ...(verifiedAssessment?.feedback
            ? { pronunciationFeedback: verifiedAssessment.feedback }
            : {}),
        },
        progress,
        skills: evidence,
        algorithmVersion: this.version,
      };
      await tx.query(
        'UPDATE product_gotit.practice_attempts SET response_receipt=$4 WHERE application_id=$1 AND application_user_id=$2 AND id=$3',
        [...scopeValues(scope), attemptId, JSON.stringify({ requestHash: hash, data })],
      );
      return { ...data, replayed: false };
    });
  }
  private async recordActivity(tx: DatabaseTransaction, scope: ProfileScope, day: string) {
    const current = (
      await tx.query(
        'SELECT current_streak_days,longest_streak_days,last_activity_date::text AS activity_day FROM product_gotit.user_gamification WHERE application_id=$1 AND application_user_id=$2 FOR UPDATE',
        scopeValues(scope),
      )
    ).rows[0];
    const streak =
      current?.activity_day === day
        ? current.current_streak_days
        : current?.activity_day === previousDay(day)
          ? current.current_streak_days + 1
          : 1;
    await tx.query(
      `INSERT INTO product_gotit.user_gamification(application_id,application_user_id,current_streak_days,longest_streak_days,last_activity_date) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(application_id,application_user_id) DO UPDATE SET current_streak_days=EXCLUDED.current_streak_days,longest_streak_days=EXCLUDED.longest_streak_days,last_activity_date=EXCLUDED.last_activity_date,updated_at=now()`,
      [...scopeValues(scope), streak, Math.max(streak, current?.longest_streak_days ?? 0), day],
    );
  }
  private async award(
    tx: DatabaseTransaction,
    scope: ProfileScope,
    key: string,
    type: string,
    id: string | null,
    amount: number,
    day: string,
    timezone: string,
    now: Date,
  ) {
    if (amount <= 0) return 0;
    const daily = (
      await tx.query(
        'SELECT COALESCE(sum(xp_amount),0)::integer xp FROM product_gotit.xp_events WHERE application_id=$1 AND application_user_id=$2 AND (created_at AT TIME ZONE $4)::date=$3::date',
        [...scopeValues(scope), day, timezone],
      )
    ).rows[0]!.xp;
    amount = xpAwardForDailyTotal(
      amount,
      Number(daily),
      this.policy.dailyXpCap,
      this.policy.postDailyCapPercent,
    );
    if (!amount) return 0;
    const inserted = await tx.query(
      `INSERT INTO product_gotit.xp_events(application_id,application_user_id,source_type,source_id,xp_amount,reason_code,idempotency_key,created_at) VALUES($1,$2,$3,$4,$5,$3,$6,$7)
      ON CONFLICT(application_id,application_user_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`,
      [...scopeValues(scope), type, id, amount, key, now],
    );
    if (!inserted.rowCount) return 0;
    const current = (
      await tx.query(
        'SELECT total_xp,current_streak_days,longest_streak_days,last_activity_date::text AS activity_day FROM product_gotit.user_gamification WHERE application_id=$1 AND application_user_id=$2 FOR UPDATE',
        scopeValues(scope),
      )
    ).rows[0];
    const total = Number(current?.total_xp ?? 0) + amount,
      streak = current?.current_streak_days ?? 0;
    await tx.query(
      `INSERT INTO product_gotit.user_gamification(application_id,application_user_id,total_xp,current_level,current_streak_days,longest_streak_days,last_activity_date)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(application_id,application_user_id) DO UPDATE SET total_xp=EXCLUDED.total_xp,current_level=EXCLUDED.current_level,current_streak_days=EXCLUDED.current_streak_days,longest_streak_days=EXCLUDED.longest_streak_days,last_activity_date=EXCLUDED.last_activity_date,updated_at=now()`,
      [
        ...scopeValues(scope),
        total,
        levelForXp(total),
        streak,
        Math.max(streak, current?.longest_streak_days ?? 0),
        current?.activity_day ?? null,
      ],
    );
    return amount;
  }
}

function hideAnswers(context: string | null, answers: string[]) {
  if (!context) return null;
  let result = context;
  for (const answer of answers) {
    const escaped = answer.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    result = result.replace(new RegExp(escaped, 'giu'), '_____');
  }
  return result.slice(0, 4000);
}
