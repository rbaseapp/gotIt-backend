export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE product_gotit.realtime_call_tickets (
      id uuid PRIMARY KEY,
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      feature text NOT NULL CHECK(feature IN ('private_lesson','course_interview')),
      lesson_id uuid,
      provider_secret text,
      provider_credential_issued boolean NOT NULL DEFAULT false,
      status text NOT NULL CHECK(status IN ('reserved','issued','connecting','active','ended','cancelled','failed')),
      duration_seconds integer NOT NULL CHECK(duration_seconds BETWEEN 1 AND 1800),
      call_id text,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      expires_at timestamptz NOT NULL,
      started_at timestamptz,
      ends_at timestamptz,
      FOREIGN KEY(application_id,application_user_id)
        REFERENCES product_gotit.user_profiles(application_id,application_user_id)
        ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX realtime_call_one_active_per_user
      ON product_gotit.realtime_call_tickets(application_id,application_user_id)
      WHERE status IN ('reserved','issued','connecting','active');
    CREATE INDEX realtime_call_due_idx
      ON product_gotit.realtime_call_tickets(status,ends_at)
      WHERE status='active';
    CREATE INDEX realtime_call_daily_idx
      ON product_gotit.realtime_call_tickets(application_id,application_user_id,feature,created_at);
  `);
};

export const down = (pgm) => {
  pgm.dropTable({ schema: 'product_gotit', name: 'realtime_call_tickets' });
};
