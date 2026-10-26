export const up = (pgm) => {
  pgm.sql(`CREATE TABLE product_gotit.admin_unit_history (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    application_id uuid NOT NULL,
    pack_id uuid NOT NULL REFERENCES product_gotit.word_packs(id),
    application_user_id uuid,
    actor_id uuid NOT NULL,
    kind text NOT NULL CHECK(kind IN ('draft','published')),
    base_revision integer NOT NULL,
    content jsonb NOT NULL,
    reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY(application_id,application_user_id) REFERENCES product_gotit.user_profiles(application_id,application_user_id)
  );
  CREATE INDEX admin_unit_history_scope ON product_gotit.admin_unit_history(application_id,pack_id,application_user_id,id DESC);
  CREATE TABLE product_gotit.unit_reading_progress (
    application_id uuid NOT NULL,
    application_user_id uuid NOT NULL,
    pack_id uuid NOT NULL REFERENCES product_gotit.word_packs(id),
    reading_id text NOT NULL,
    content_hash text NOT NULL,
    completed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(application_id,application_user_id,pack_id,reading_id,content_hash),
    FOREIGN KEY(application_id,application_user_id) REFERENCES product_gotit.user_profiles(application_id,application_user_id)
  );`);
};
export const down = (pgm) => {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM product_gotit.admin_unit_history) OR EXISTS(SELECT 1 FROM product_gotit.unit_reading_progress)
    THEN RAISE EXCEPTION 'Curriculum history or reading progress exists; retain schema and roll back code'; END IF;
  END $$;
  DROP TABLE product_gotit.unit_reading_progress,product_gotit.admin_unit_history;`);
};
