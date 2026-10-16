export const up = (pgm) => {
  pgm.sql(`CREATE TABLE product_gotit.admin_unit_content (
    application_id uuid NOT NULL,
    pack_id uuid NOT NULL REFERENCES product_gotit.word_packs(id),
    application_user_id uuid,
    revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
    content jsonb NOT NULL CHECK(jsonb_typeof(content)='object'),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT(application_id,pack_id,application_user_id),
    FOREIGN KEY(application_id,application_user_id) REFERENCES product_gotit.user_profiles(application_id,application_user_id)
  );
  ALTER TABLE product_gotit.private_lesson_sessions ADD COLUMN realtime_contract jsonb;
  COMMENT ON COLUMN product_gotit.private_lesson_sessions.realtime_contract IS 'Admin-only session instructions/configuration snapshot; no provider credentials or audio';`);
};
export const down = (pgm) => {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM product_gotit.admin_unit_content)
      OR EXISTS(SELECT 1 FROM product_gotit.private_lesson_sessions WHERE realtime_contract IS NOT NULL)
    THEN RAISE EXCEPTION 'Authored content or prompt snapshots exist; retain schema and roll back application code'; END IF;
  END $$;
  ALTER TABLE product_gotit.private_lesson_sessions DROP COLUMN realtime_contract;
  DROP TABLE product_gotit.admin_unit_content;`);
};
