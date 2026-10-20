import { readFileSync } from 'node:fs';

export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_sessions ADD COLUMN curriculum_context jsonb;
    CREATE TABLE product_gotit.structured_program_versions (
      program_id text NOT NULL, version text NOT NULL, content jsonb NOT NULL,
      lexicon jsonb NOT NULL, visible boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(program_id,version)
    );
    CREATE TABLE product_gotit.structured_program_enrollments (
      application_id uuid NOT NULL, application_user_id uuid NOT NULL,
      program_id text NOT NULL, version text NOT NULL, revision integer NOT NULL DEFAULT 1,
      state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(application_id,application_user_id,program_id,version),
      FOREIGN KEY(application_id,application_user_id) REFERENCES product_gotit.user_profiles(application_id,application_user_id) ON DELETE CASCADE,
      FOREIGN KEY(program_id,version) REFERENCES product_gotit.structured_program_versions(program_id,version)
    );
    CREATE TABLE product_gotit.structured_program_commands (
      application_id uuid NOT NULL, application_user_id uuid NOT NULL,
      event_id uuid NOT NULL, fingerprint text NOT NULL, response jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(application_id,application_user_id,event_id),
      FOREIGN KEY(application_id,application_user_id) REFERENCES product_gotit.user_profiles(application_id,application_user_id) ON DELETE CASCADE
    );
    CREATE TABLE product_gotit.structured_program_attempts (
      id uuid PRIMARY KEY, application_id uuid NOT NULL, application_user_id uuid NOT NULL,
      program_id text NOT NULL, version text NOT NULL, activity_id text NOT NULL,
      content_revision text NOT NULL, payload jsonb NOT NULL, result jsonb,
      created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
      FOREIGN KEY(application_id,application_user_id,program_id,version)
        REFERENCES product_gotit.structured_program_enrollments(application_id,application_user_id,program_id,version) ON DELETE CASCADE
    );
    CREATE INDEX structured_attempt_owner ON product_gotit.structured_program_attempts(application_id,application_user_id,program_id,version,created_at);
    CREATE TABLE product_gotit.structured_program_catalog_overrides (
      topic_slug text PRIMARY KEY, hidden boolean NOT NULL DEFAULT false
    );
  `);
  const authored = JSON.parse(
    readFileSync(new URL('../assets/english-zero-c1/curriculum.json', import.meta.url), 'utf8'),
  );
  authored.exitAssessment = JSON.parse(
    readFileSync(
      new URL('../assets/english-zero-c1/exit-assessment.json', import.meta.url),
      'utf8',
    ),
  );
  const content = JSON.stringify(authored);
  const lexicon = readFileSync(
    new URL('../assets/english-zero-c1/lexicon.json', import.meta.url),
    'utf8',
  );
  const literal = (text) => `'${text.replaceAll("'", "''")}'::jsonb`;
  pgm.sql(`INSERT INTO product_gotit.structured_program_versions(program_id,version,content,lexicon)
    VALUES ('english-zero-c1','2026-10-21.1',${literal(content)},${literal(lexicon)});`);
};
// Historical migration rehearsals may remove an unpublished, unused import only.
// Published content or any learner evidence must never be silently dropped.
export const down = (pgm) =>
  pgm.sql(`
  DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM product_gotit.structured_program_enrollments)
      OR EXISTS(SELECT 1 FROM product_gotit.structured_program_versions WHERE visible)
      OR EXISTS(SELECT 1 FROM product_gotit.private_lesson_sessions WHERE curriculum_context IS NOT NULL)
    THEN RAISE EXCEPTION 'Curriculum rollback is protected: published content or learner evidence exists'; END IF;
  END $$;
  DROP TABLE product_gotit.structured_program_attempts;
  DROP TABLE product_gotit.structured_program_commands;
  DROP TABLE product_gotit.structured_program_enrollments;
  DROP TABLE product_gotit.structured_program_versions;
  DROP TABLE product_gotit.structured_program_catalog_overrides;
  ALTER TABLE product_gotit.private_lesson_sessions DROP COLUMN curriculum_context;
`);
