export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.practice_sessions ADD COLUMN client_event_id text,
      ADD COLUMN request_hash text, ADD COLUMN response_receipt jsonb,
      ADD COLUMN selection jsonb NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE product_gotit.user_profiles ADD COLUMN learning_preferences jsonb;
    ALTER TABLE product_gotit.learning_items ADD COLUMN learning_revision integer NOT NULL DEFAULT 1 CHECK(learning_revision>0);
    ALTER TABLE product_gotit.item_translations ADD COLUMN is_current boolean NOT NULL DEFAULT true;
    ALTER TABLE product_gotit.item_occurrences ADD COLUMN learning_revision integer NOT NULL DEFAULT 1 CHECK(learning_revision>0);
    ALTER TABLE product_gotit.item_examples ADD COLUMN learning_revision integer NOT NULL DEFAULT 1 CHECK(learning_revision>0);
    CREATE UNIQUE INDEX practice_sessions_client_event_idx ON product_gotit.practice_sessions
      (application_id,application_user_id,client_event_id) WHERE client_event_id IS NOT NULL;
    ALTER TABLE product_gotit.practice_attempts ADD COLUMN request_hash text, ADD COLUMN response_receipt jsonb,
      ADD COLUMN learning_revision integer CHECK(learning_revision>0);
    CREATE UNIQUE INDEX practice_attempts_unique_sequence_idx ON product_gotit.practice_attempts
      (application_id,application_user_id,practice_session_id,attempt_sequence);
    CREATE TABLE product_gotit.practice_exercises (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),application_id uuid NOT NULL,application_user_id uuid NOT NULL,
      practice_session_id uuid NOT NULL,learning_item_id uuid NOT NULL,
      exercise_type text NOT NULL,prompt_direction text NOT NULL,prompt jsonb NOT NULL,answer_spec jsonb NOT NULL,
      item_snapshot_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL,
      consumed_at timestamptz,CONSTRAINT practice_exercises_scoped_identity UNIQUE(application_id,application_user_id,id),
      CONSTRAINT practice_exercises_session_fkey FOREIGN KEY(application_id,application_user_id,practice_session_id)
        REFERENCES product_gotit.practice_sessions(application_id,application_user_id,id) ON DELETE CASCADE,
      CONSTRAINT practice_exercises_learning_item_fkey FOREIGN KEY(application_id,application_user_id,learning_item_id)
        REFERENCES product_gotit.learning_items(application_id,application_user_id,id) ON DELETE CASCADE,
      CONSTRAINT practice_exercises_type_check CHECK(exercise_type IN('flashcards','recall','listening_spelling','matching','pronunciation','article_quiz')),
      CONSTRAINT practice_exercises_expiry_check CHECK(expires_at>created_at)
    );
    CREATE INDEX practice_exercises_session_idx ON product_gotit.practice_exercises(application_id,application_user_id,practice_session_id,created_at);
    ALTER TABLE product_gotit.generated_contents ADD COLUMN request_hash text,ADD COLUMN publication_receipt jsonb;
    ALTER TABLE product_gotit.practice_sessions ADD CONSTRAINT practice_sessions_hash_check CHECK(request_hash IS NULL OR request_hash ~ '^[a-f0-9]{64}$'),
      ADD CONSTRAINT practice_sessions_receipt_check CHECK(response_receipt IS NULL OR (request_hash IS NOT NULL AND jsonb_typeof(response_receipt)='object'));
    ALTER TABLE product_gotit.practice_attempts ADD CONSTRAINT practice_attempts_hash_check CHECK(request_hash IS NULL OR request_hash ~ '^[a-f0-9]{64}$'),
      ADD CONSTRAINT practice_attempts_receipt_check CHECK(response_receipt IS NULL OR (request_hash IS NOT NULL AND jsonb_typeof(response_receipt)='object'));
    ALTER TABLE product_gotit.generated_contents ADD CONSTRAINT generated_contents_hash_check CHECK(request_hash IS NULL OR request_hash ~ '^[a-f0-9]{64}$'),
      ADD CONSTRAINT generated_contents_receipt_check CHECK(publication_receipt IS NULL OR (request_hash IS NOT NULL AND jsonb_typeof(publication_receipt)='object'));
    CREATE TABLE product_gotit.api_rate_limits (
      bucket_key text PRIMARY KEY,window_start timestamptz NOT NULL,request_count integer NOT NULL CHECK(request_count>0),
      expires_at timestamptz NOT NULL
    );
    CREATE INDEX api_rate_limits_expiry_idx ON product_gotit.api_rate_limits(expires_at);
  `);
};
export const down = (pgm) => {
  pgm.sql(`DROP TABLE product_gotit.api_rate_limits;DROP TABLE product_gotit.practice_exercises;
    ALTER TABLE product_gotit.generated_contents DROP COLUMN request_hash,DROP COLUMN publication_receipt;
    DROP INDEX product_gotit.practice_attempts_unique_sequence_idx;
    ALTER TABLE product_gotit.practice_attempts DROP COLUMN request_hash,DROP COLUMN response_receipt;
    DROP INDEX product_gotit.practice_sessions_client_event_idx;
    ALTER TABLE product_gotit.practice_sessions DROP COLUMN client_event_id,DROP COLUMN request_hash,DROP COLUMN response_receipt,DROP COLUMN selection;
    ALTER TABLE product_gotit.user_profiles DROP COLUMN learning_preferences;`);
  pgm.sql(
    'ALTER TABLE product_gotit.learning_items DROP COLUMN learning_revision;ALTER TABLE product_gotit.practice_attempts DROP COLUMN learning_revision;ALTER TABLE product_gotit.item_translations DROP COLUMN is_current;ALTER TABLE product_gotit.item_occurrences DROP COLUMN learning_revision;ALTER TABLE product_gotit.item_examples DROP COLUMN learning_revision;',
  );
};
