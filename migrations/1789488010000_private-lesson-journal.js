export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE product_gotit.private_lesson_sessions (
      id uuid NOT NULL,
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      target_language_code varchar(64) NOT NULL,
      support_language_code varchar(64),
      level varchar(2) NOT NULL CHECK(level IN('A1','A2','B1','B2','C1','C2')),
      topic varchar(120) NOT NULL,
      grammar_focus varchar(160),
      teacher_voice varchar(10) NOT NULL CHECK(teacher_voice IN('female','male')),
      speech_rate varchar(10) NOT NULL CHECK(speech_rate IN('slow','normal','fast')),
      planned_duration_seconds integer NOT NULL CHECK(planned_duration_seconds BETWEEN 1 AND 1200),
      actual_duration_seconds integer CHECK(actual_duration_seconds BETWEEN 0 AND 1800),
      target_words jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(target_words)='array'),
      status varchar(20) NOT NULL DEFAULT 'active' CHECK(status IN('active','summarizing','completed','report_failed')),
      report jsonb CHECK(report IS NULL OR jsonb_typeof(report)='object'),
      report_generated_at timestamptz,
      report_error_code varchar(50),
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(application_id,application_user_id,id),
      FOREIGN KEY(application_id,application_user_id)
        REFERENCES product_gotit.user_profiles(application_id,application_user_id)
        ON DELETE CASCADE
    );
    CREATE INDEX private_lesson_sessions_history_idx
      ON product_gotit.private_lesson_sessions(application_id,application_user_id,started_at DESC)
      WHERE deleted_at IS NULL;
  `);
};

export const down = (pgm) => {
  pgm.dropTable({ schema: 'product_gotit', name: 'private_lesson_sessions' });
};
