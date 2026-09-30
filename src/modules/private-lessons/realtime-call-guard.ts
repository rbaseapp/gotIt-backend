import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { AppError } from '../../shared/errors/app-error.js';
import type { ProfileScope } from '../profile/profile.types.js';
import type { MinuteWallet } from './minute-wallet.js';

export const REALTIME_CONNECT_PATH = '/api/v1/realtime/connect';
export const REALTIME_END_PATH = '/api/v1/realtime/end';
const TICKET_TTL_SECONDS = 120;
const END_GRACE_SECONDS = 30;

type Feature = 'private_lesson' | 'course_interview';
type TicketRow = { id: string; lesson_id: string | null };

export interface RealtimeCallGuard {
  reserve(
    scope: ProfileScope,
    feature: Feature,
    durationSeconds: number,
    lessonId?: string,
  ): Promise<string>;
  issue(ticketId: string, providerSecret: string): Promise<void>;
  cancel(ticketId: string): Promise<void>;
}

export class PostgresRealtimeCallGuard implements RealtimeCallGuard {
  constructor(
    private readonly pool: Pool,
    private readonly apiKey: string,
    private readonly minuteWallet?: MinuteWallet,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async reserve(scope: ProfileScope, feature: Feature, durationSeconds: number, lessonId?: string) {
    const limit = feature === 'private_lesson' ? 30 : 20;
    const id = randomUUID();
    const db = await this.pool.connect();
    let expired: TicketRow[] = [];
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))', [
        scope.applicationId,
        scope.applicationUserId,
      ]);
      expired = (
        await db.query<TicketRow>(
          `UPDATE product_gotit.realtime_call_tickets
           SET status='cancelled',provider_secret=NULL
           WHERE application_id=$1 AND application_user_id=$2
             AND status IN ('reserved','issued','connecting') AND expires_at<clock_timestamp()
           RETURNING id,lesson_id`,
          [scope.applicationId, scope.applicationUserId],
        )
      ).rows;
      const result = await db.query<{ daily_count: string; active_count: string }>(
        `SELECT
           count(*) FILTER (WHERE feature=$3 AND provider_credential_issued
             AND created_at>=date_trunc('day',clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AS daily_count,
           count(*) FILTER (WHERE status IN ('reserved','issued','connecting','active')) AS active_count
         FROM product_gotit.realtime_call_tickets
         WHERE application_id=$1 AND application_user_id=$2`,
        [scope.applicationId, scope.applicationUserId, feature],
      );
      const current = result.rows[0]!;
      if (Number(current.active_count) > 0)
        throw new AppError(409, 'AI_SESSION_ACTIVE', 'Finish the current voice session first');
      if (Number(current.daily_count) >= limit)
        throw new AppError(
          429,
          'AI_DAILY_LIMIT_REACHED',
          'The daily voice session limit was reached',
        );
      await db.query(
        `INSERT INTO product_gotit.realtime_call_tickets
          (id,application_id,application_user_id,feature,lesson_id,status,duration_seconds,expires_at)
         VALUES($1,$2,$3,$4,$5,'reserved',$6,clock_timestamp()+make_interval(secs=>$7))`,
        [
          id,
          scope.applicationId,
          scope.applicationUserId,
          feature,
          lessonId ?? null,
          durationSeconds,
          TICKET_TTL_SECONDS,
        ],
      );
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505')
        throw new AppError(409, 'AI_SESSION_ACTIVE', 'Finish the current voice session first');
      throw error;
    } finally {
      db.release();
    }
    await Promise.all(expired.map((row) => this.refund(row.lesson_id)));
    return id;
  }

  async issue(ticketId: string, providerSecret: string) {
    const result = await this.pool.query(
      `UPDATE product_gotit.realtime_call_tickets
       SET status='issued',provider_secret=$2,provider_credential_issued=true,
           expires_at=clock_timestamp()+make_interval(secs=>$3)
       WHERE id=$1 AND status='reserved' AND expires_at>clock_timestamp()`,
      [ticketId, providerSecret, TICKET_TTL_SECONDS],
    );
    if (!result.rowCount)
      throw new AppError(503, 'AI_SESSION_UNAVAILABLE', 'Voice session could not start');
  }

  async cancel(ticketId: string) {
    const result = await this.pool.query<TicketRow>(
      `UPDATE product_gotit.realtime_call_tickets
       SET status='cancelled',provider_secret=NULL
       WHERE id=$1 AND status IN ('reserved','issued')
       RETURNING id,lesson_id`,
      [ticketId],
    );
    await Promise.all(result.rows.map((row) => this.refund(row.lesson_id)));
  }

  async connect(ticketId: string, sdp: string): Promise<string> {
    if (
      !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu.test(ticketId) ||
      !sdp.startsWith('v=0\r\n') ||
      sdp.length > 16_384
    )
      throw new AppError(400, 'VALIDATION_ERROR', 'Invalid voice connection request');
    const result = await this.pool.query<{
      provider_secret: string;
      lesson_id: string | null;
      duration_seconds: number;
    }>(
      `UPDATE product_gotit.realtime_call_tickets
       SET status='connecting'
       WHERE id=$1 AND status='issued' AND expires_at>clock_timestamp()
       RETURNING provider_secret,lesson_id,duration_seconds`,
      [ticketId],
    );
    const ticket = result.rows[0];
    if (!ticket?.provider_secret)
      throw new AppError(
        409,
        'AI_SESSION_UNAVAILABLE',
        'Voice session expired or was already used',
      );
    let callId: string | null = null;
    try {
      const response = await this.fetchImpl('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${ticket.provider_secret}`,
          'content-type': 'application/sdp',
        },
        body: sdp,
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`Realtime connection rejected: ${response.status}`);
      const location = response.headers.get('location');
      callId = location?.match(/\/realtime\/calls\/(rtc_[\w-]+)$/u)?.[1] ?? null;
      if (!callId) throw new Error('Realtime call ID missing');
      const answer = await response.text();
      if (!answer.startsWith('v=0\r\n') || answer.length > 65_536)
        throw new Error('Realtime SDP answer invalid');
      const saved = await this.pool.query(
        `UPDATE product_gotit.realtime_call_tickets
         SET status='active',provider_secret=NULL,call_id=$2,started_at=clock_timestamp(),
             ends_at=clock_timestamp()+make_interval(secs=>$3)
         WHERE id=$1 AND status='connecting'`,
        [ticketId, callId, ticket.duration_seconds + END_GRACE_SECONDS],
      );
      if (!saved.rowCount) throw new Error('Realtime ticket was cancelled');
      return answer;
    } catch {
      if (callId) await this.hangup(callId).catch(() => undefined);
      await this.pool.query(
        `UPDATE product_gotit.realtime_call_tickets
         SET status='failed',provider_secret=NULL WHERE id=$1 AND status='connecting'`,
        [ticketId],
      );
      await this.refund(ticket.lesson_id);
      throw new AppError(503, 'AI_SESSION_UNAVAILABLE', 'Voice connection could not start');
    }
  }

  async end(ticketId: string) {
    if (!/^[\da-f-]{36}$/iu.test(ticketId)) return;
    const result = await this.pool.query<{ call_id: string }>(
      `SELECT call_id FROM product_gotit.realtime_call_tickets
       WHERE id=$1 AND status='active'`,
      [ticketId],
    );
    const callId = result.rows[0]?.call_id;
    if (callId) await this.finish(ticketId, callId);
    else await this.cancel(ticketId);
  }

  async sweep() {
    const expired = await this.pool.query<TicketRow>(
      `UPDATE product_gotit.realtime_call_tickets
       SET status='cancelled',provider_secret=NULL
       WHERE status IN ('reserved','issued','connecting') AND expires_at<clock_timestamp()
       RETURNING id,lesson_id`,
    );
    await Promise.all(expired.rows.map((row) => this.refund(row.lesson_id)));
    const due = await this.pool.query<{ id: string; call_id: string }>(
      `SELECT id,call_id FROM product_gotit.realtime_call_tickets
       WHERE status='active' AND ends_at<clock_timestamp()
       ORDER BY ends_at LIMIT 25`,
    );
    await Promise.all(due.rows.map((row) => this.finish(row.id, row.call_id)));
  }

  private async finish(ticketId: string, callId: string) {
    await this.hangup(callId);
    await this.pool.query(
      `UPDATE product_gotit.realtime_call_tickets SET status='ended'
       WHERE id=$1 AND status='active'`,
      [ticketId],
    );
  }

  private async hangup(callId: string) {
    const response = await this.fetchImpl(
      `https://api.openai.com/v1/realtime/calls/${callId}/hangup`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok && response.status !== 404)
      throw new Error(`Realtime hangup failed: ${response.status}`);
  }

  private async refund(lessonId: string | null) {
    if (lessonId) await this.minuteWallet?.release(lessonId);
  }
}
