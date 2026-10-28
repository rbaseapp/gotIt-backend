/**
 * Onboarding gives every new account a small, time-limited block of teacher minutes during the
 * free trial. Core reports it as a minute grant of kind 'trial', so the wallet table has to accept
 * that source kind alongside subscriptions and purchases.
 */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_minute_grants
      DROP CONSTRAINT IF EXISTS private_lesson_minute_grants_source_kind_check;
    ALTER TABLE product_gotit.private_lesson_minute_grants
      ADD CONSTRAINT private_lesson_minute_grants_source_kind_check
      CHECK (source_kind IN ('subscription','purchase','trial'));
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM product_gotit.private_lesson_minute_grants WHERE source_kind='trial') THEN
        RAISE EXCEPTION 'Trial minute grants exist; refusing to discard them';
      END IF;
    END
    $$;
    ALTER TABLE product_gotit.private_lesson_minute_grants
      DROP CONSTRAINT IF EXISTS private_lesson_minute_grants_source_kind_check;
    ALTER TABLE product_gotit.private_lesson_minute_grants
      ADD CONSTRAINT private_lesson_minute_grants_source_kind_check
      CHECK (source_kind IN ('subscription','purchase'));
  `);
};
