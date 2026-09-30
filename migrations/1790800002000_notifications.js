export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE product_gotit.notification_preferences (
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      practice_email boolean NOT NULL DEFAULT false,
      practice_push boolean NOT NULL DEFAULT false,
      system_email boolean NOT NULL DEFAULT false,
      system_push boolean NOT NULL DEFAULT false,
      reminder_hour smallint NOT NULL DEFAULT 18 CHECK (reminder_hour BETWEEN 0 AND 23),
      verified_email varchar(320),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (application_id, application_user_id),
      FOREIGN KEY (application_id, application_user_id)
        REFERENCES product_gotit.user_profiles(application_id, application_user_id) ON DELETE CASCADE
    );
    CREATE TABLE product_gotit.push_subscriptions (
      id uuid PRIMARY KEY,
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      endpoint text NOT NULL UNIQUE,
      p256dh text NOT NULL,
      auth text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (application_id, application_user_id)
        REFERENCES product_gotit.user_profiles(application_id, application_user_id) ON DELETE CASCADE
    );
    CREATE INDEX push_subscriptions_owner ON product_gotit.push_subscriptions(application_id, application_user_id);
    CREATE TABLE product_gotit.notification_deliveries (
      id uuid PRIMARY KEY,
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      kind varchar(16) NOT NULL CHECK (kind IN ('practice', 'system')),
      channel varchar(8) NOT NULL CHECK (channel IN ('email', 'push')),
      occurrence_key varchar(128) NOT NULL,
      subject varchar(200) NOT NULL,
      body varchar(2000) NOT NULL,
      status varchar(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'uncertain', 'suppressed')),
      attempts smallint NOT NULL DEFAULT 0,
      next_attempt_at timestamptz NOT NULL DEFAULT now(),
      lease_until timestamptz,
      last_error_code varchar(80),
      sent_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (application_id, application_user_id, kind, channel, occurrence_key),
      FOREIGN KEY (application_id, application_user_id)
        REFERENCES product_gotit.user_profiles(application_id, application_user_id) ON DELETE CASCADE
    );
    CREATE INDEX notification_deliveries_due ON product_gotit.notification_deliveries(next_attempt_at)
      WHERE status IN ('pending', 'failed');
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE product_gotit.notification_deliveries;
    DROP TABLE product_gotit.push_subscriptions;
    DROP TABLE product_gotit.notification_preferences;
  `);
};
