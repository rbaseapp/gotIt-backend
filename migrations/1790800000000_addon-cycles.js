export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE product_gotit.addon_packages (
      key text PRIMARY KEY,
      kind text NOT NULL CHECK (kind IN ('ai', 'private_lessons')),
      lessons_per_cycle integer CHECK (lessons_per_cycle > 0),
      lesson_duration_seconds integer CHECK (lesson_duration_seconds > 0),
      active boolean NOT NULL DEFAULT false,
      CHECK ((kind = 'ai' AND lessons_per_cycle IS NULL AND lesson_duration_seconds IS NULL)
        OR (kind = 'private_lessons' AND lessons_per_cycle IS NOT NULL)),
      CHECK (NOT active OR kind = 'ai' OR lesson_duration_seconds IS NOT NULL)
    );

    INSERT INTO product_gotit.addon_packages(key,kind,lessons_per_cycle)
    VALUES ('ai','ai',NULL),('lessons-2','private_lessons',2),
      ('lessons-4','private_lessons',4),('lessons-8','private_lessons',8),
      ('lessons-12','private_lessons',12);

    CREATE TABLE product_gotit.addon_cycles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      package_key text NOT NULL REFERENCES product_gotit.addon_packages(key),
      kind text NOT NULL CHECK (kind IN ('ai', 'private_lessons')),
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      lesson_limit integer CHECK (lesson_limit > 0),
      lesson_duration_seconds integer CHECK (lesson_duration_seconds > 0),
      lessons_used integer NOT NULL DEFAULT 0 CHECK (lessons_used >= 0),
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (starts_at < ends_at),
      CHECK ((kind = 'ai' AND lesson_limit IS NULL AND lesson_duration_seconds IS NULL AND lessons_used = 0)
        OR (kind = 'private_lessons' AND lesson_limit IS NOT NULL
          AND lesson_duration_seconds IS NOT NULL AND lessons_used <= lesson_limit)),
      FOREIGN KEY(application_id,application_user_id)
        REFERENCES product_gotit.user_profiles(application_id,application_user_id) ON DELETE CASCADE
    );
    CREATE INDEX addon_cycles_lookup ON product_gotit.addon_cycles
      (application_id,application_user_id,kind,ends_at DESC);

    CREATE TABLE product_gotit.addon_lesson_reservations (
      lesson_id uuid PRIMARY KEY,
      cycle_id uuid NOT NULL REFERENCES product_gotit.addon_cycles(id),
      reserved_at timestamptz NOT NULL DEFAULT now(),
      released_at timestamptz
    );

    CREATE FUNCTION product_gotit.validate_addon_cycle() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE selected product_gotit.addon_packages%ROWTYPE;
    BEGIN
      SELECT * INTO selected FROM product_gotit.addon_packages WHERE key=NEW.package_key;
      IF NOT FOUND OR NOT selected.active OR selected.kind <> NEW.kind
        OR NEW.lesson_limit IS DISTINCT FROM selected.lessons_per_cycle
        OR NEW.lesson_duration_seconds IS DISTINCT FROM selected.lesson_duration_seconds THEN
        RAISE EXCEPTION 'Addon package is inactive or cycle terms do not match the approved package';
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER validate_addon_cycle BEFORE INSERT OR UPDATE OF package_key,kind,lesson_limit,lesson_duration_seconds
      ON product_gotit.addon_cycles FOR EACH ROW EXECUTE FUNCTION product_gotit.validate_addon_cycle();

    CREATE FUNCTION product_gotit.reject_overlapping_addon_cycles() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.revoked_at IS NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended(
          NEW.application_id::text || ':' || NEW.application_user_id::text || ':' || NEW.kind, 0));
        IF EXISTS (
          SELECT 1 FROM product_gotit.addon_cycles existing
          WHERE existing.application_id=NEW.application_id
            AND existing.application_user_id=NEW.application_user_id
            AND existing.kind=NEW.kind AND existing.revoked_at IS NULL
            AND existing.id<>NEW.id
            AND tstzrange(existing.starts_at,existing.ends_at,'[)') &&
              tstzrange(NEW.starts_at,NEW.ends_at,'[)')
        ) THEN
          RAISE EXCEPTION 'Overlapping add-on cycles are not allowed';
        END IF;
      END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER reject_overlapping_addon_cycles
      BEFORE INSERT OR UPDATE OF application_id,application_user_id,kind,starts_at,ends_at,revoked_at
      ON product_gotit.addon_cycles FOR EACH ROW
      EXECUTE FUNCTION product_gotit.reject_overlapping_addon_cycles();
  `);
};

export const down = (pgm) => {
  pgm.dropTable({ schema: 'product_gotit', name: 'addon_lesson_reservations' });
  pgm.dropTable({ schema: 'product_gotit', name: 'addon_cycles' });
  pgm.sql('DROP FUNCTION product_gotit.reject_overlapping_addon_cycles()');
  pgm.sql('DROP FUNCTION product_gotit.validate_addon_cycle()');
  pgm.dropTable({ schema: 'product_gotit', name: 'addon_packages' });
};
