export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE product_gotit.learning_documents (
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      id uuid NOT NULL,
      kind varchar(16) NOT NULL CHECK (kind IN ('course','homework')),
      revision integer NOT NULL CHECK (revision >= 0),
      document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(application_id,application_user_id,id),
      FOREIGN KEY(application_id,application_user_id)
        REFERENCES product_gotit.user_profiles(application_id,application_user_id) ON DELETE CASCADE
    );
    CREATE INDEX learning_documents_recent ON product_gotit.learning_documents
      (application_id,application_user_id,kind,updated_at DESC);
    CREATE TABLE product_gotit.learning_commands (
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      event_id uuid NOT NULL,
      document_id uuid NOT NULL,
      fingerprint varchar(64) NOT NULL,
      response_document jsonb NOT NULL CHECK (jsonb_typeof(response_document) = 'object'),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(application_id,application_user_id,event_id),
      FOREIGN KEY(application_id,application_user_id,document_id)
        REFERENCES product_gotit.learning_documents(application_id,application_user_id,id) ON DELETE CASCADE
    );
    ALTER TABLE product_gotit.private_lesson_sessions ADD COLUMN course_context jsonb;
  `);
};
export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_sessions DROP COLUMN course_context;
    DROP TABLE product_gotit.learning_commands;
    DROP TABLE product_gotit.learning_documents;
  `);
};
