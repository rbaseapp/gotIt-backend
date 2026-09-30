export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_preferences
      DROP CONSTRAINT private_lesson_preferences_requested_duration_minutes_check;
    ALTER TABLE product_gotit.private_lesson_preferences
      ADD CONSTRAINT private_lesson_preferences_requested_duration_minutes_check
      CHECK (requested_duration_minutes IN (1,5,10,15,20));
    CREATE TABLE product_gotit.private_lesson_minute_grants (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      source_kind text NOT NULL CHECK (source_kind IN ('subscription','purchase')),
      source_id text NOT NULL,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      seconds_total integer NOT NULL CHECK (seconds_total > 0),
      seconds_used integer NOT NULL DEFAULT 0 CHECK (seconds_used >= 0 AND seconds_used <= seconds_total),
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (starts_at < ends_at),
      UNIQUE (source_kind,source_id,starts_at)
    );
    CREATE INDEX private_lesson_minute_grants_user
      ON product_gotit.private_lesson_minute_grants(application_id,application_user_id,ends_at);
    CREATE TABLE product_gotit.private_lesson_minute_reservations (
      lesson_id uuid NOT NULL,
      grant_id uuid NOT NULL REFERENCES product_gotit.private_lesson_minute_grants(id),
      seconds_reserved integer NOT NULL CHECK (seconds_reserved > 0),
      released_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(lesson_id,grant_id)
    );
  `);
};

export const down = (pgm) => {
  pgm.sql('DROP TABLE product_gotit.private_lesson_minute_reservations');
  pgm.sql('DROP TABLE product_gotit.private_lesson_minute_grants');
  pgm.sql(`UPDATE product_gotit.private_lesson_preferences SET requested_duration_minutes=15
    WHERE requested_duration_minutes=20`);
  pgm.sql(`ALTER TABLE product_gotit.private_lesson_preferences
    DROP CONSTRAINT private_lesson_preferences_requested_duration_minutes_check;
    ALTER TABLE product_gotit.private_lesson_preferences
    ADD CONSTRAINT private_lesson_preferences_requested_duration_minutes_check
    CHECK (requested_duration_minutes IN (1,5,10,15))`);
};
