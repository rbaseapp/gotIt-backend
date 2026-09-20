import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { withTransaction } from '../../shared/database/transaction.js';
import { AppError } from '../../shared/errors/app-error.js';
import { itemSnapshot, scopeValues, itemNotFound } from '../library/library.repository.js';
import type { ProfileScope } from '../profile/profile.types.js';
import type { PracticeService } from '../practice/practice.service.js';
import { fingerprint } from '../enrichment/selection-proof.js';

export interface SpeechProvider {
  readonly id: string;
  supports(language: string, operation: 'listening' | 'pronunciation'): boolean;
  synthesize(
    text: string,
    language: string,
    signal: AbortSignal,
  ): Promise<{ audio: Buffer; contentType: 'audio/wav' | 'audio/mpeg' }>;
  assess(
    input: { audio: Buffer; text: string; language: string; idempotencyKey: string },
    signal: AbortSignal,
  ): Promise<{ score: number; feedback: string; model: string | null }>;
}
export function validateWav(audio: Buffer) {
  const invalid = () =>
    new AppError(400, 'AUDIO_INVALID', 'Audio must be 16 kHz mono PCM WAV, up to 15 seconds');
  if (
    audio.length < 44 ||
    audio.length > 500000 ||
    audio.toString('ascii', 0, 4) !== 'RIFF' ||
    audio.toString('ascii', 8, 12) !== 'WAVE' ||
    audio.readUInt32LE(4) !== audio.length - 8
  )
    throw invalid();
  let position = 12,
    format = false,
    dataSize = 0,
    hasData = false;
  while (position < audio.length) {
    if (position + 8 > audio.length) throw invalid();
    const kind = audio.toString('ascii', position, position + 4),
      size = audio.readUInt32LE(position + 4),
      start = position + 8,
      end = start + size;
    if (end > audio.length) throw invalid();
    if (kind === 'fmt ') {
      if (
        format ||
        size < 16 ||
        audio.readUInt16LE(start) !== 1 ||
        audio.readUInt16LE(start + 2) !== 1 ||
        audio.readUInt32LE(start + 4) !== 16000 ||
        audio.readUInt32LE(start + 8) !== 32000 ||
        audio.readUInt16LE(start + 12) !== 2 ||
        audio.readUInt16LE(start + 14) !== 16
      )
        throw invalid();
      format = true;
    }
    if (kind === 'data') {
      if (hasData || size === 0 || size % 2 !== 0) throw invalid();
      hasData = true;
      dataSize = size;
    }
    position = end + (size % 2);
    if (position > audio.length) throw invalid();
  }
  if (!format || !hasData || dataSize < 3200 || dataSize > 480000) throw invalid();
  return { durationSeconds: dataSize / 32000 };
}
export class SpeechService {
  constructor(
    private readonly pool: Pool,
    private readonly practice: PracticeService,
    private readonly provider?: SpeechProvider,
  ) {}
  supports = (language: string, kind: 'listening' | 'pronunciation') =>
    this.provider?.supports(language, kind) ?? false;
  get available() {
    return Boolean(this.provider);
  }
  private async bounded<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 10000);
    try {
      return await Promise.race([
        operation(controller.signal),
        new Promise<never>((_resolve, reject) =>
          controller.signal.addEventListener('abort', () => reject(new Error('Speech timeout')), {
            once: true,
          }),
        ),
      ]);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'SPEECH_UNAVAILABLE', 'Speech provider is temporarily unavailable');
    } finally {
      clearTimeout(timer);
    }
  }
  async audio(scope: ProfileScope, id: string) {
    const row = await withTransaction(
      this.pool,
      async (tx) => {
        const item = (
          await tx.query(
            'SELECT source_text,source_language_code FROM product_gotit.learning_items WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL',
            [...scopeValues(scope), id],
          )
        ).rows[0];
        if (!item) throw itemNotFound();
        return item;
      },
      true,
    );
    if (!this.provider?.supports(row.source_language_code, 'listening'))
      throw new AppError(
        503,
        'SPEECH_NOT_CONFIGURED',
        'Reference audio is not configured for this language',
      );
    const result = await this.bounded((signal) =>
      this.provider!.synthesize(row.source_text, row.source_language_code, signal),
    );
    if (
      !Buffer.isBuffer(result.audio) ||
      !result.audio.length ||
      result.audio.length > 1000000 ||
      !['audio/wav', 'audio/mpeg'].includes(result.contentType)
    )
      throw new AppError(503, 'SPEECH_UNAVAILABLE', 'Invalid speech provider response');
    return result;
  }
  async assess(scope: ProfileScope, key: string, exerciseId: string, audio: Buffer) {
    validateWav(audio);
    const hash = fingerprint({
      exerciseId,
      audioHash: createHash('sha256').update(audio).digest('hex'),
    });
    const snapshot = await withTransaction(
      this.pool,
      async (tx) => {
        const prior = (
          await tx.query(
            'SELECT request_hash,response_receipt FROM product_gotit.practice_attempts WHERE application_id=$1 AND application_user_id=$2 AND client_event_id=$3',
            [...scopeValues(scope), key],
          )
        ).rows[0];
        if (prior) {
          if (prior.request_hash !== hash)
            throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Assessment event key was reused');
          return { replay: true } as const;
        }
        const exercise = (
          await tx.query(
            `SELECT e.*,s.status FROM product_gotit.practice_exercises e JOIN product_gotit.practice_sessions s ON s.application_id=e.application_id AND s.application_user_id=e.application_user_id AND s.id=e.practice_session_id WHERE e.application_id=$1 AND e.application_user_id=$2 AND e.id=$3`,
            [...scopeValues(scope), exerciseId],
          )
        ).rows[0];
        if (!exercise) throw new AppError(404, 'NOT_FOUND', 'Exercise not found');
        if (exercise.exercise_type !== 'pronunciation')
          throw new AppError(
            400,
            'VALIDATION_ERROR',
            'Assessment requires a pronunciation exercise',
          );
        if (
          exercise.status !== 'active' ||
          exercise.consumed_at ||
          exercise.expires_at.getTime() <= Date.now()
        )
          throw new AppError(409, 'EXERCISE_UNAVAILABLE', 'Exercise is no longer available');
        const item = (
          await tx.query(
            'SELECT * FROM product_gotit.learning_items WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND deleted_at IS NULL',
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
          itemSnapshot(item, translations) !== exercise.item_snapshot_hash
        )
          throw new AppError(409, 'EXERCISE_STALE', 'Learning item changed');
        return {
          replay: false,
          text: item.source_text as string,
          language: item.source_language_code as string,
        } as const;
      },
      true,
    );
    // The normal public attempt route can never supply this verified score or hash.
    const input = {
      exerciseId,
      answerText: 'verified pronunciation',
      skipped: false,
      hintsUsed: 0,
    };
    if (snapshot.replay)
      return this.practice.submitAttempt(scope, key, input, {
        score: 0,
        summary: '',
        exerciseId,
        requestHash: hash,
      });
    if (!this.provider?.supports(snapshot.language, 'pronunciation'))
      throw new AppError(
        503,
        'SPEECH_NOT_CONFIGURED',
        'Pronunciation provider is not configured for this language',
      );
    const parsed = z
      .object({
        score: z.number().finite().min(0).max(100),
        feedback: z.string().max(2000),
        model: z.string().max(200).nullable(),
      })
      .strict()
      .safeParse(
        await this.bounded((signal) =>
          this.provider!.assess(
            {
              audio,
              text: snapshot.text,
              language: snapshot.language,
              idempotencyKey: fingerprint({ ...scope, key }),
            },
            signal,
          ),
        ),
      );
    if (!parsed.success)
      throw new AppError(503, 'SPEECH_UNAVAILABLE', 'Invalid speech provider assessment');
    const result = parsed.data;
    return this.practice.submitAttempt(scope, key, input, {
      score: result.score,
      feedback: result.feedback,
      summary: JSON.stringify({
        provider: this.provider.id,
        model: result.model,
        feedback: result.feedback,
      }),
      exerciseId,
      requestHash: hash,
    });
  }
}
