import { createHash, randomUUID } from 'node:crypto';
import { curriculumTeacherVoice } from './curriculum.participants.js';
import type { Pool } from 'pg';
import { withTransaction, type DatabaseTransaction } from '../../shared/database/transaction.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { ProfileScope } from '../profile/profile.types.js';
import { PROGRAM_ID, PROGRAM_VERSION, type Question, type Band } from './curriculum.content.js';
import type { WordEvidence } from './curriculum.policy.js';

export type CurriculumState = {
  pathChoices?: { units: string[]; activities: string[] };
  minutes: number;
  timezone: string;
  literacy: 'starting' | 'developing' | 'independent';
  currentUnit: string;
  words: Record<string, WordEvidence>;
  completed: Record<string, { at: string; independent: boolean; score: number; source?: string }>;
  cursors: Record<string, number>;
  drafts: Record<string, string>;
  activeSeconds: number;
  lastReadingSeconds: number;
  lastReadingTargets: number;
  reviewSeconds?: number;
  placement: Record<string, { band: string; score: number; independent: boolean }>;
  recentSessions: Array<{ accuracy: number | null; reviewShare: number }>;
  heartbeat?: { activityId: string; at: string; credited: number };
  articleJob?: string;
  activeAttempts?: Record<string, string>;
  practiceItems?: Record<string, string>;
  /** Set when the learner was placed by the onboarding check (see curriculum.placement.ts). */
  onboarding?: {
    theta: number;
    startUnit: number;
    goal: string;
    deadlineMonths: number;
    minutesPerDay: number;
    reliability: number;
    placedAt: string;
    /** What the learner told us in the first-entry questions (see the placement flow doc). */
    profile?: {
      selfLevel?: 0 | 1 | 2 | 3;
      /** The tap-to-answer conversation check, when the learner did it. */
      talk?: { correct: number; total: number; unknown?: number };
    };
  };
};
export type Enrollment = { revision: number; state: CurriculumState };
export type Grade = {
  correct: boolean;
  message: boolean;
  criteria: boolean[];
  feedback: string;
  answer: string | null;
  independent: boolean;
  modality: string;
};
export type ActivityAttempt = {
  id: string;
  activityId: string;
  contentRevision: string;
  createdAt: string;
  payload: {
    questions: Question[];
    cursor: number;
    grades: Grade[];
    assisted: number[];
    audioPlayed: number[];
    exposed: number[];
    startActiveSeconds?: number;
    startReviewSeconds?: number;
    pending?: { eventId: string; fingerprint: string; at: string; nonce?: string };
    transcriptions?: Record<string, { text: string; cursor: number }>;
    playedParts?: string[];
    meta?: {
      status: 'generating' | 'ready' | 'failed';
      nonce: string;
      title?: string;
      text?: string;
      coverage?: number;
      unknown?: string[];
      band?: Band;
      selected?: string[];
      independentReady?: boolean;
      leaseAt?: string;
    };
  };
  result: { score: number; independent: boolean; complete: boolean } | null;
};
export const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const scopeArgs = (scope: ProfileScope) => [scope.applicationId, scope.applicationUserId];
export const curriculumConflict = () =>
  new AppError(409, 'CURRICULUM_CHANGED', 'Reload your saved progress before continuing');
export const curriculumMissing = () =>
  new AppError(404, 'CURRICULUM_NOT_FOUND', 'Learning activity not found');

export class CurriculumStore {
  constructor(readonly pool: Pool) {}
  async teacherVoice(
    scope: ProfileScope,
    completedLessonSource?: string,
    tx?: DatabaseTransaction,
  ): Promise<'female' | 'male'> {
    return curriculumTeacherVoice(tx ?? this.pool, scope, completedLessonSource);
  }

  async catalog() {
    const row = (
      await this.pool.query(
        'SELECT visible FROM product_gotit.structured_program_versions WHERE program_id=$1 AND version=$2',
        [PROGRAM_ID, PROGRAM_VERSION],
      )
    ).rows[0];
    return row?.visible === true;
  }
  async get(scope: ProfileScope): Promise<Enrollment | null> {
    const row = (
      await this.pool.query(
        `SELECT revision,state FROM product_gotit.structured_program_enrollments
      WHERE application_id=$1 AND application_user_id=$2 AND program_id=$3 AND version=$4`,
        [...scopeArgs(scope), PROGRAM_ID, PROGRAM_VERSION],
      )
    ).rows[0];
    return row ? { revision: Number(row.revision), state: row.state as CurriculumState } : null;
  }
  async attempt(
    scope: ProfileScope,
    id: string,
    tx?: DatabaseTransaction,
  ): Promise<ActivityAttempt> {
    const query = (text: string, values: unknown[]) =>
      tx ? tx.query(text, values) : this.pool.query(text, values);
    const row = (
      await query(
        `SELECT id,activity_id,content_revision,payload,result,created_at
      FROM product_gotit.structured_program_attempts WHERE application_id=$1 AND application_user_id=$2
      AND program_id=$3 AND version=$4 AND id=$5`,
        [...scopeArgs(scope), PROGRAM_ID, PROGRAM_VERSION, id],
      )
    ).rows[0];
    if (!row) throw curriculumMissing();
    return {
      id: String(row.id),
      activityId: String(row.activity_id),
      contentRevision: String(row.content_revision),
      createdAt: new Date(row.created_at as string).toISOString(),
      payload: row.payload as ActivityAttempt['payload'],
      result: row.result as ActivityAttempt['result'],
    };
  }
  async saveAttempt(tx: DatabaseTransaction, scope: ProfileScope, attempt: ActivityAttempt) {
    const saved = await tx.query(
      `INSERT INTO product_gotit.structured_program_attempts
      (id,application_id,application_user_id,program_id,version,activity_id,content_revision,payload,result,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)
      ON CONFLICT(id) DO UPDATE SET payload=EXCLUDED.payload,result=EXCLUDED.result,completed_at=EXCLUDED.completed_at
      WHERE structured_program_attempts.application_id=EXCLUDED.application_id AND structured_program_attempts.application_user_id=EXCLUDED.application_user_id
        AND structured_program_attempts.program_id=EXCLUDED.program_id AND structured_program_attempts.version=EXCLUDED.version`,
      [
        attempt.id,
        ...scopeArgs(scope),
        PROGRAM_ID,
        PROGRAM_VERSION,
        attempt.activityId,
        attempt.contentRevision,
        JSON.stringify(attempt.payload),
        attempt.result ? JSON.stringify(attempt.result) : null,
        attempt.result ? new Date().toISOString() : null,
      ],
    );
    if (!saved.rowCount) throw curriculumConflict();
  }
  async reserveAi<T>(
    scope: ProfileScope,
    eventId: string,
    input: unknown,
    revision: number,
    activity: string,
  ): Promise<{ response: T } | { nonce: string }> {
    return withTransaction(this.pool, async (tx) => {
      await tx.lock(['curriculum', ...scopeArgs(scope), PROGRAM_ID, PROGRAM_VERSION]);
      const hash = fingerprint(input);
      const receipt = (
        await tx.query(
          'SELECT fingerprint,response FROM product_gotit.structured_program_commands WHERE application_id=$1 AND application_user_id=$2 AND event_id=$3',
          [...scopeArgs(scope), eventId],
        )
      ).rows[0];
      if (receipt) {
        if (receipt.fingerprint !== hash) throw curriculumConflict();
        return { response: receipt.response as T };
      }
      const row = (
        await tx.query(
          'SELECT revision FROM product_gotit.structured_program_enrollments WHERE application_id=$1 AND application_user_id=$2 AND program_id=$3 AND version=$4',
          [...scopeArgs(scope), PROGRAM_ID, PROGRAM_VERSION],
        )
      ).rows[0];
      if (!row || Number(row.revision) !== revision) throw curriculumConflict();
      const competing = (
        await tx.query(
          `SELECT id FROM product_gotit.structured_program_attempts WHERE application_id=$1 AND application_user_id=$2
        AND program_id=$3 AND version=$4 AND activity_id=$5 AND result IS NULL AND payload->'pending'->>'at' > $6 LIMIT 1`,
          [
            ...scopeArgs(scope),
            PROGRAM_ID,
            PROGRAM_VERSION,
            activity,
            new Date(Date.now() - 100_000).toISOString(),
          ],
        )
      ).rows[0];
      if (competing)
        throw new AppError(
          409,
          'CURRICULUM_ANSWER_IN_PROGRESS',
          'This step is already being prepared',
        );
      let lease: ActivityAttempt;
      try {
        lease = await this.attempt(scope, eventId, tx);
        if (lease.activityId !== activity || lease.payload.pending?.fingerprint !== hash)
          throw curriculumConflict();
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== 'CURRICULUM_NOT_FOUND') throw error;
        lease = {
          id: eventId,
          activityId: activity,
          contentRevision: PROGRAM_VERSION,
          createdAt: new Date().toISOString(),
          payload: {
            questions: [],
            cursor: 0,
            grades: [],
            assisted: [],
            audioPlayed: [],
            exposed: [],
          },
          result: null,
        };
      }
      const nonce = randomUUID();
      lease.payload.pending = { eventId, fingerprint: hash, at: new Date().toISOString(), nonce };
      await this.saveAttempt(tx, scope, lease);
      return { nonce };
    });
  }
  async finishAi(tx: DatabaseTransaction, scope: ProfileScope, eventId: string, nonce: string) {
    const lease = await this.attempt(scope, eventId, tx);
    if (lease.payload.pending?.nonce !== nonce) throw curriculumConflict();
    delete lease.payload.pending;
    lease.result = { score: 0, independent: false, complete: true };
    await this.saveAttempt(tx, scope, lease);
  }
  async releaseAi(scope: ProfileScope, eventId: string, nonce: string) {
    await this.pool.query(
      `UPDATE product_gotit.structured_program_attempts SET payload=jsonb_set(payload,'{pending,at}','"1970-01-01T00:00:00.000Z"'::jsonb)
      WHERE application_id=$1 AND application_user_id=$2 AND id=$3 AND payload->'pending'->>'nonce'=$4`,
      [...scopeArgs(scope), eventId, nonce],
    );
  }
  async command<T>(
    scope: ProfileScope,
    eventId: string,
    input: unknown,
    revision: number | null,
    mutate: (
      enrollment: Enrollment | null,
      tx: DatabaseTransaction,
    ) => Promise<{ state: CurriculumState; response: T }>,
    bumpRevision = true,
  ) {
    return withTransaction(this.pool, async (tx) => {
      await tx.lock(['curriculum', ...scopeArgs(scope), PROGRAM_ID, PROGRAM_VERSION]);
      const hash = fingerprint(input);
      const receipt = (
        await tx.query(
          `SELECT fingerprint,response FROM product_gotit.structured_program_commands
        WHERE application_id=$1 AND application_user_id=$2 AND event_id=$3`,
          [...scopeArgs(scope), eventId],
        )
      ).rows[0];
      if (receipt) {
        if (receipt.fingerprint !== hash) throw curriculumConflict();
        return receipt.response as T;
      }
      const row = (
        await tx.query(
          `SELECT revision,state FROM product_gotit.structured_program_enrollments
        WHERE application_id=$1 AND application_user_id=$2 AND program_id=$3 AND version=$4 FOR UPDATE`,
          [...scopeArgs(scope), PROGRAM_ID, PROGRAM_VERSION],
        )
      ).rows[0];
      const enrollment: Enrollment | null = row
        ? { revision: Number(row.revision), state: row.state as CurriculumState }
        : null;
      if (revision !== null && enrollment?.revision !== revision) throw curriculumConflict();
      const { state, response } = await mutate(enrollment, tx);
      await tx.query(
        `INSERT INTO product_gotit.structured_program_enrollments(application_id,application_user_id,program_id,version,revision,state)
        VALUES($1,$2,$3,$4,1,$5::jsonb) ON CONFLICT(application_id,application_user_id,program_id,version)
        DO UPDATE SET state=EXCLUDED.state,revision=structured_program_enrollments.revision+$6::integer,updated_at=now()`,
        [
          ...scopeArgs(scope),
          PROGRAM_ID,
          PROGRAM_VERSION,
          JSON.stringify(state),
          Number(bumpRevision),
        ],
      );
      await tx.query(
        `INSERT INTO product_gotit.structured_program_commands(application_id,application_user_id,event_id,fingerprint,response)
        VALUES($1,$2,$3,$4,$5::jsonb)`,
        [...scopeArgs(scope), eventId, hash, JSON.stringify(response)],
      );
      return response;
    });
  }
}
