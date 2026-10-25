import { randomUUID } from 'node:crypto';
import type { DatabasePool } from '../../shared/database/pool.js';
import type { ProfileScope } from '../profile/profile.types.js';
import type { NotificationPreferences } from './notification.policy.js';

const extraColumns = {
  enabled: 'enabled',
  reminderMinute: 'reminder_minute',
  reminderDays: 'reminder_days',
  quietEnabled: 'quiet_enabled',
  quietStart: 'quiet_start',
  quietEnd: 'quiet_end',
  streakEmail: 'streak_email',
  streakPush: 'streak_push',
  weeklyEmail: 'weekly_email',
  weeklyPush: 'weekly_push',
} as const;
type PreferenceRow = {
  enabled?: boolean;
  reminder_minute?: number;
  reminder_days?: number[];
  quiet_enabled?: boolean;
  quiet_start?: number;
  quiet_end?: number;
  streak_email?: boolean;
  streak_push?: boolean;
  weekly_email?: boolean;
  weekly_push?: boolean;
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
  kind: 'practice' | 'system' | 'streak' | 'weekly';
  channel: 'email' | 'push';
  occurrence_key: string;
  subject: string;
  body: string;
  attempts: number;
  verified_email: string | null;
};

const defaults: NotificationPreferences = {
  enabled: true,
  reminderMinute: 0,
  reminderDays: [0, 1, 2, 3, 4, 5, 6],
  quietEnabled: false,
  quietStart: 1320,
  quietEnd: 420,
  streakEmail: false,
  streakPush: false,
  weeklyEmail: false,
  weeklyPush: false,
  practiceEmail: false,
  practicePush: false,
  systemEmail: false,
  systemPush: false,
  reminderHour: 18,
};

function map(row: PreferenceRow | undefined): NotificationPreferences {
  if (!row) return defaults;
  return {
    ...defaults,
    ...Object.fromEntries(
      Object.entries(extraColumns)
        .filter(([, column]) => row[column as keyof PreferenceRow] !== undefined)
        .map(([key, column]) => [key, row[column as keyof PreferenceRow]]),
    ),
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
      `SELECT *
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
    const columns = {
      practiceEmail: 'practice_email',
      practicePush: 'practice_push',
      systemEmail: 'system_email',
      systemPush: 'system_push',
      reminderHour: 'reminder_hour',
      ...extraColumns,
    };
    const entries = Object.entries(patch).filter(([key]) => key in columns);
    const names = entries.map(([key]) => columns[key as keyof typeof columns]);
    const values = entries.map(([, value]) => value);
    const result = await this.pool.query<PreferenceRow>(
      `
      INSERT INTO product_gotit.notification_preferences(application_id,application_user_id,verified_email,${names.join(',')})
      VALUES($1,$2,$3,${names.map((_, i) => '$' + (i + 4)).join(',')})
      ON CONFLICT(application_id,application_user_id) DO UPDATE SET
      verified_email=$3,${names.map((name) => `${name}=EXCLUDED.${name}`).join(',')},updated_at=now()
      RETURNING *`,
      [scope.applicationId, scope.applicationUserId, verifiedEmail ?? null, ...values],
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
    const result = await this.pool.query(
      `
      WITH clocks AS (
        SELECT n.*, p.timezone, $1::timestamptz AT TIME ZONE p.timezone AS local_now
        FROM product_gotit.notification_preferences n
        JOIN product_gotit.user_profiles p USING(application_id,application_user_id)
        WHERE n.enabled
      ), candidates AS (
        SELECT c.*,extract(hour FROM local_now)::int*60+extract(minute FROM local_now)::int AS minute,
          local_now::date AS local_day FROM clocks c
      ), eligible AS (
        SELECT c.*,v.kind,v.channel,v.enabled AS channel_enabled FROM candidates c
        CROSS JOIN LATERAL (VALUES
          ('practice','email',c.practice_email),('practice','push',c.practice_push),
          ('streak','email',c.streak_email),('streak','push',c.streak_push),
          ('weekly','email',c.weekly_email),('weekly','push',c.weekly_push)
        ) v(kind,channel,enabled)
        WHERE v.enabled AND extract(dow FROM c.local_now)::int=ANY(c.reminder_days)
          AND c.minute >= c.reminder_hour*60+c.reminder_minute
          AND NOT(c.quiet_enabled AND CASE WHEN c.quiet_start<c.quiet_end
            THEN c.minute>=c.quiet_start AND c.minute<c.quiet_end
            ELSE c.minute>=c.quiet_start OR c.minute<c.quiet_end END)
          AND (v.channel<>'email' OR c.verified_email IS NOT NULL)
          AND (v.channel<>'push' OR EXISTS(SELECT 1 FROM product_gotit.push_subscriptions ps WHERE ps.application_id=c.application_id AND ps.application_user_id=c.application_user_id))
          AND (v.kind='weekly' AND extract(dow FROM c.local_now)=0 AND EXISTS(
            SELECT 1 FROM product_gotit.practice_attempts a WHERE a.application_id=c.application_id AND a.application_user_id=c.application_user_id AND a.created_at >= $1::timestamptz-interval '7 days' AND a.result<>'skipped')
          OR v.kind IN ('practice','streak') AND NOT EXISTS(
            SELECT 1 FROM product_gotit.practice_attempts a WHERE a.application_id=c.application_id AND a.application_user_id=c.application_user_id AND (a.created_at AT TIME ZONE c.timezone)::date=c.local_day AND a.result<>'skipped')
            AND (v.kind='practice' AND EXISTS(SELECT 1 FROM product_gotit.learning_items li WHERE li.application_id=c.application_id AND li.application_user_id=c.application_user_id AND li.deleted_at IS NULL AND li.user_status='active' AND li.next_review_at<=$1)
            OR v.kind='streak' AND EXISTS(SELECT 1 FROM product_gotit.practice_attempts a WHERE a.application_id=c.application_id AND a.application_user_id=c.application_user_id AND (a.created_at AT TIME ZONE c.timezone)::date=c.local_day-1 AND a.result<>'skipped')))
      )
      INSERT INTO product_gotit.notification_deliveries(id,application_id,application_user_id,kind,channel,occurrence_key,subject,body)
      SELECT gen_random_uuid(),application_id,application_user_id,kind,channel,local_day::text,
        CASE kind WHEN 'weekly' THEN 'GotIt ? Your weekly progress' WHEN 'streak' THEN 'GotIt ? Keep your streak' ELSE 'GotIt ? Time to practice' END,
        CASE kind WHEN 'weekly' THEN 'Your weekly progress is ready. Open GotIt to see your learning activity and continue your plan.' WHEN 'streak' THEN 'You practiced yesterday. A short practice today will keep your learning streak going.' ELSE 'Your vocabulary is ready for review. Open GotIt for a short practice.' END
      FROM eligible ON CONFLICT(application_id,application_user_id,kind,channel,occurrence_key) DO NOTHING`,
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
       WHERE n.application_id=$1 AND n.application_user_id=$2 AND v.enabled AND n.enabled
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
         SELECT d.id FROM product_gotit.notification_deliveries d
         JOIN product_gotit.notification_preferences n USING(application_id,application_user_id)
         JOIN product_gotit.user_profiles p USING(application_id,application_user_id)
         WHERE n.enabled AND NOT(n.quiet_enabled AND CASE WHEN n.quiet_start<n.quiet_end
           THEN (extract(hour FROM $1::timestamptz AT TIME ZONE p.timezone)*60+extract(minute FROM $1::timestamptz AT TIME ZONE p.timezone))>=n.quiet_start AND (extract(hour FROM $1::timestamptz AT TIME ZONE p.timezone)*60+extract(minute FROM $1::timestamptz AT TIME ZONE p.timezone))<n.quiet_end
           ELSE (extract(hour FROM $1::timestamptz AT TIME ZONE p.timezone)*60+extract(minute FROM $1::timestamptz AT TIME ZONE p.timezone))>=n.quiet_start OR (extract(hour FROM $1::timestamptz AT TIME ZONE p.timezone)*60+extract(minute FROM $1::timestamptz AT TIME ZONE p.timezone))<n.quiet_end END) AND status IN ('pending','failed') AND next_attempt_at <= $1 AND attempts < 5
           AND channel=ANY($2::varchar[])
           AND (kind='system' OR d.created_at >= $1::timestamptz-interval '1 day')
         ORDER BY next_attempt_at,d.id FOR UPDATE OF d SKIP LOCKED LIMIT 1
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
      `SELECT n.enabled AND CASE WHEN $3='streak' AND $4='email' THEN n.streak_email AND n.verified_email IS NOT NULL
                   WHEN $3='streak' AND $4='push' THEN n.streak_push
                   WHEN $3='weekly' AND $4='email' THEN n.weekly_email AND n.verified_email IS NOT NULL
                   WHEN $3='weekly' AND $4='push' THEN n.weekly_push
                   WHEN $3='practice' AND $4='email' THEN n.practice_email AND n.verified_email IS NOT NULL
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
       WHERE kind<>'system' AND status IN ('pending','failed')
         AND created_at < $1::timestamptz-interval '1 day'`,
      [now],
    );
  }
}
