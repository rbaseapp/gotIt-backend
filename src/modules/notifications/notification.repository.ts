import { randomUUID } from 'node:crypto';
import type { DatabasePool } from '../../shared/database/pool.js';
import type { ProfileScope } from '../profile/profile.types.js';
import type { NotificationPreferences } from './notification.policy.js';

type PreferenceRow = {
  practice_email: boolean;
  practice_push: boolean;
  system_email: boolean;
  system_push: boolean;
  reminder_hour: number;
};

export type Delivery = {
  id: string;
  application_id: string;
  application_user_id: string;
  kind: 'practice' | 'system';
  channel: 'email' | 'push';
  occurrence_key: string;
  subject: string;
  body: string;
  attempts: number;
  verified_email: string | null;
};

const defaults: NotificationPreferences = {
  practiceEmail: false,
  practicePush: false,
  systemEmail: false,
  systemPush: false,
  reminderHour: 18,
};

function map(row: PreferenceRow | undefined): NotificationPreferences {
  if (!row) return defaults;
  return {
    practiceEmail: row.practice_email,
    practicePush: row.practice_push,
    systemEmail: row.system_email,
    systemPush: row.system_push,
    reminderHour: row.reminder_hour,
  };
}

export class NotificationRepository {
  constructor(private readonly pool: DatabasePool) {}

  async getPreferences(scope: ProfileScope) {
    const result = await this.pool.query<PreferenceRow>(
      `SELECT practice_email,practice_push,system_email,system_push,reminder_hour
       FROM product_gotit.notification_preferences
       WHERE application_id=$1 AND application_user_id=$2`,
      [scope.applicationId, scope.applicationUserId],
    );
    return map(result.rows[0]);
  }

  async patchPreferences(
    scope: ProfileScope,
    patch: Partial<NotificationPreferences>,
    verifiedEmail?: string,
  ) {
    const result = await this.pool.query<PreferenceRow>(
      `INSERT INTO product_gotit.notification_preferences
       (application_id,application_user_id,practice_email,practice_push,system_email,system_push,reminder_hour,verified_email)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(application_id,application_user_id) DO UPDATE SET
         practice_email=COALESCE($9,notification_preferences.practice_email),
         practice_push=COALESCE($10,notification_preferences.practice_push),
         system_email=COALESCE($11,notification_preferences.system_email),
         system_push=COALESCE($12,notification_preferences.system_push),
         reminder_hour=COALESCE($13,notification_preferences.reminder_hour),
         verified_email=$8,updated_at=now()
       RETURNING practice_email,practice_push,system_email,system_push,reminder_hour`,
      [
        scope.applicationId,
        scope.applicationUserId,
        patch.practiceEmail ?? false,
        patch.practicePush ?? false,
        patch.systemEmail ?? false,
        patch.systemPush ?? false,
        patch.reminderHour ?? 18,
        verifiedEmail ?? null,
        patch.practiceEmail ?? null,
        patch.practicePush ?? null,
        patch.systemEmail ?? null,
        patch.systemPush ?? null,
        patch.reminderHour ?? null,
      ],
    );
    return map(result.rows[0]);
  }

  async addSubscription(
    scope: ProfileScope,
    input: { endpoint: string; keys: { p256dh: string; auth: string } },
  ) {
    await this.pool.query(
      `INSERT INTO product_gotit.push_subscriptions(id,application_id,application_user_id,endpoint,p256dh,auth)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(endpoint) DO UPDATE SET
         application_id=EXCLUDED.application_id,
         application_user_id=EXCLUDED.application_user_id,
         p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth`,
      [
        randomUUID(),
        scope.applicationId,
        scope.applicationUserId,
        input.endpoint,
        input.keys.p256dh,
        input.keys.auth,
      ],
    );
  }

  async removeSubscription(scope: ProfileScope, endpoint: string) {
    await this.pool.query(
      `DELETE FROM product_gotit.push_subscriptions WHERE application_id=$1 AND application_user_id=$2 AND endpoint=$3`,
      [scope.applicationId, scope.applicationUserId, endpoint],
    );
  }

  async subscriptions(scope: ProfileScope) {
    const result = await this.pool.query<{ endpoint: string; p256dh: string; auth: string }>(
      `SELECT endpoint,p256dh,auth FROM product_gotit.push_subscriptions
       WHERE application_id=$1 AND application_user_id=$2`,
      [scope.applicationId, scope.applicationUserId],
    );
    return result.rows;
  }

  async queuePractice(now: Date) {
    // The local date and hour come from the profile; the unique occurrence key survives DST repeats.
    const result = await this.pool.query(
      `WITH candidates AS (
         SELECT p.application_id,p.application_user_id,p.timezone,n.reminder_hour,
           to_char($1::timestamptz AT TIME ZONE p.timezone,'YYYY-MM-DD') AS local_day,
           n.practice_email,n.practice_push,n.verified_email
         FROM product_gotit.notification_preferences n
         JOIN product_gotit.user_profiles p USING(application_id,application_user_id)
         WHERE extract(hour FROM $1::timestamptz AT TIME ZONE p.timezone)>=n.reminder_hour
           AND (n.practice_email OR n.practice_push)
       ), eligible AS (
         SELECT c.* FROM candidates c
         WHERE EXISTS (
           SELECT 1 FROM product_gotit.learning_items li
           WHERE li.application_id=c.application_id AND li.application_user_id=c.application_user_id
             AND li.deleted_at IS NULL AND li.user_status='active' AND li.next_review_at <= $1
         ) AND NOT EXISTS (
           SELECT 1 FROM product_gotit.practice_attempts a
           WHERE a.application_id=c.application_id AND a.application_user_id=c.application_user_id
             AND (a.created_at AT TIME ZONE c.timezone)::date=c.local_day::date
             AND a.result<>'skipped'
         )
       )
       INSERT INTO product_gotit.notification_deliveries
         (id,application_id,application_user_id,kind,channel,occurrence_key,subject,body)
       SELECT gen_random_uuid(),e.application_id,e.application_user_id,'practice',v.channel,e.local_day,
         'Time to practice','You have vocabulary ready for review in GotIt.'
       FROM eligible e CROSS JOIN LATERAL (
         VALUES('email',e.practice_email AND e.verified_email IS NOT NULL),
               ('push',e.practice_push AND EXISTS(
                 SELECT 1 FROM product_gotit.push_subscriptions s
                 WHERE s.application_id=e.application_id AND s.application_user_id=e.application_user_id))
       ) AS v(channel,enabled)
       WHERE v.enabled
       ON CONFLICT(application_id,application_user_id,kind,channel,occurrence_key) DO NOTHING`,
      [now],
    );
    return result.rowCount ?? 0;
  }

  async queueSystem(scope: ProfileScope, eventKey: string, subject: string, body: string) {
    const result = await this.pool.query(
      `INSERT INTO product_gotit.notification_deliveries
         (id,application_id,application_user_id,kind,channel,occurrence_key,subject,body)
       SELECT gen_random_uuid(),n.application_id,n.application_user_id,'system',v.channel,$3,$4,$5
       FROM product_gotit.notification_preferences n
       CROSS JOIN LATERAL (
         VALUES('email',n.system_email AND n.verified_email IS NOT NULL),
               ('push',n.system_push AND EXISTS(
                 SELECT 1 FROM product_gotit.push_subscriptions s
                 WHERE s.application_id=n.application_id AND s.application_user_id=n.application_user_id))
       ) AS v(channel,enabled)
       WHERE n.application_id=$1 AND n.application_user_id=$2 AND v.enabled
       ON CONFLICT(application_id,application_user_id,kind,channel,occurrence_key) DO NOTHING`,
      [scope.applicationId, scope.applicationUserId, eventKey, subject, body],
    );
    return result.rowCount ?? 0;
  }

  async claim(
    now: Date,
    channels: Array<'email' | 'push'> = ['email', 'push'],
  ): Promise<Delivery | undefined> {
    const result = await this.pool.query<Delivery>(
      `WITH picked AS (
         SELECT id FROM product_gotit.notification_deliveries
         WHERE status IN ('pending','failed') AND next_attempt_at <= $1 AND attempts < 5
           AND channel=ANY($2::varchar[])
           AND (kind='system' OR created_at >= $1::timestamptz-interval '1 day')
         ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1
       ) UPDATE product_gotit.notification_deliveries d
       SET status='sending',attempts=attempts+1,lease_until=$1::timestamptz+interval '2 minutes'
       FROM picked,product_gotit.notification_preferences n
       WHERE d.id=picked.id AND n.application_id=d.application_id
         AND n.application_user_id=d.application_user_id
       RETURNING d.*,n.verified_email`,
      [now, channels],
    );
    return result.rows[0];
  }

  async allowed(delivery: Delivery): Promise<boolean> {
    const scope = [delivery.application_id, delivery.application_user_id];
    const result = await this.pool.query<{ allowed: boolean }>(
      `SELECT CASE WHEN $3='practice' AND $4='email' THEN n.practice_email AND n.verified_email IS NOT NULL
                   WHEN $3='practice' AND $4='push' THEN n.practice_push
                   WHEN $3='system' AND $4='email' THEN n.system_email AND n.verified_email IS NOT NULL
                   ELSE n.system_push END AS allowed
       FROM product_gotit.notification_preferences n
       WHERE application_id=$1 AND application_user_id=$2`,
      [...scope, delivery.kind, delivery.channel],
    );
    return result.rows[0]?.allowed === true;
  }

  async finish(
    id: string,
    status: 'sent' | 'failed' | 'uncertain' | 'suppressed',
    errorCode?: string,
    retryAt?: Date,
  ) {
    await this.pool.query(
      `UPDATE product_gotit.notification_deliveries
       SET status=$2::varchar,last_error_code=$3,next_attempt_at=COALESCE($4,next_attempt_at),
         sent_at=CASE WHEN $2::varchar='sent' THEN now() ELSE sent_at END,lease_until=NULL
       WHERE id=$1 AND status='sending'`,
      [id, status, errorCode ?? null, retryAt ?? null],
    );
  }

  async expireLeases(now: Date) {
    await this.pool.query(
      `UPDATE product_gotit.notification_deliveries
       SET status='uncertain',last_error_code='LEASE_EXPIRED',lease_until=NULL
       WHERE status='sending' AND lease_until < $1`,
      [now],
    );
  }

  async suppressStale(now: Date) {
    await this.pool.query(
      `UPDATE product_gotit.notification_deliveries
       SET status='suppressed',last_error_code='REMINDER_EXPIRED'
       WHERE kind='practice' AND status IN ('pending','failed')
         AND created_at < $1::timestamptz-interval '1 day'`,
      [now],
    );
  }
}
