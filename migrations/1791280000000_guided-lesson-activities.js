export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_sessions ADD COLUMN word_pack_context jsonb
      CHECK(word_pack_context IS NULL OR jsonb_typeof(word_pack_context)='object');
    CREATE TABLE product_gotit.private_lesson_activities (
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      lesson_id uuid NOT NULL,
      revision integer NOT NULL DEFAULT 0 CHECK(revision BETWEEN 0 AND 100),
      plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object'),
      snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(application_id,application_user_id,lesson_id),
      FOREIGN KEY(application_id,application_user_id,lesson_id)
        REFERENCES product_gotit.private_lesson_sessions(application_id,application_user_id,id)
        ON DELETE CASCADE
    );
    CREATE TABLE product_gotit.private_lesson_activity_commands (
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      lesson_id uuid NOT NULL,
      event_id uuid NOT NULL,
      fingerprint varchar(64) NOT NULL,
      snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(application_id,application_user_id,lesson_id,event_id),
      FOREIGN KEY(application_id,application_user_id,lesson_id)
        REFERENCES product_gotit.private_lesson_activities(application_id,application_user_id,lesson_id)
        ON DELETE CASCADE
    );
  `);
};
export const down = (pgm) => {
  pgm.dropTable({ schema: 'product_gotit', name: 'private_lesson_activity_commands' });
  pgm.dropTable({ schema: 'product_gotit', name: 'private_lesson_activities' });
  pgm.dropColumn({ schema: 'product_gotit', name: 'private_lesson_sessions' }, 'word_pack_context');
};
