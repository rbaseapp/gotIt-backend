export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.user_language_proficiencies
      ADD COLUMN estimated_level_lower text,
      ADD COLUMN estimated_level_upper text,
      ADD COLUMN assessment_evidence_count integer NOT NULL DEFAULT 0 CHECK(assessment_evidence_count >= 0),
      ADD COLUMN calibration_target text,
      ADD CONSTRAINT user_language_proficiencies_estimated_lower_check
        CHECK(estimated_level_lower IS NULL OR estimated_level_lower IN ('A1','A2','B1','B2','C1','C2')),
      ADD CONSTRAINT user_language_proficiencies_estimated_upper_check
        CHECK(estimated_level_upper IS NULL OR estimated_level_upper IN ('A1','A2','B1','B2','C1','C2')),
      ADD CONSTRAINT user_language_proficiencies_calibration_target_check
        CHECK(calibration_target IS NULL OR calibration_target IN ('A1','A2','B1','B2','C1','C2'));

    CREATE TABLE product_gotit.private_lesson_skill_profiles (
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      language_code varchar(35) NOT NULL,
      skill varchar(24) NOT NULL CHECK(skill IN ('speaking','vocabulary','grammar','fluency','comprehension')),
      ability_score numeric(5,2) NOT NULL CHECK(ability_score BETWEEN 0 AND 100),
      confidence numeric(5,4) NOT NULL CHECK(confidence BETWEEN 0 AND 1),
      evidence_count integer NOT NULL DEFAULT 0 CHECK(evidence_count >= 0),
      strong_evidence_count integer NOT NULL DEFAULT 0 CHECK(strong_evidence_count >= 0),
      highest_tested_level varchar(2) CHECK(highest_tested_level IS NULL OR highest_tested_level IN ('A1','A2','B1','B2','C1','C2')),
      below_level_evidence_count integer NOT NULL DEFAULT 0 CHECK(below_level_evidence_count >= 0),
      last_lesson_session_id uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(application_id,application_user_id,language_code,skill),
      FOREIGN KEY(application_id,application_user_id)
        REFERENCES product_gotit.user_profiles(application_id,application_user_id) ON DELETE CASCADE,
      FOREIGN KEY(application_id,application_user_id,last_lesson_session_id)
        REFERENCES product_gotit.private_lesson_sessions(application_id,application_user_id,id)
        ON DELETE SET NULL (last_lesson_session_id)
    );

    CREATE TABLE product_gotit.private_lesson_skill_evidence (
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      lesson_session_id uuid NOT NULL,
      language_code varchar(35) NOT NULL,
      skill varchar(24) NOT NULL CHECK(skill IN ('speaking','vocabulary','grammar','fluency','comprehension')),
      task_level varchar(2) NOT NULL CHECK(task_level IN ('A1','A2','B1','B2','C1','C2')),
      observed_score smallint NOT NULL CHECK(observed_score BETWEEN 0 AND 100),
      evidence_weight numeric(5,4) NOT NULL CHECK(evidence_weight BETWEEN 0 AND 1),
      evidence_quality varchar(16) NOT NULL CHECK(evidence_quality IN ('insufficient','weak','moderate','strong')),
      dimensions jsonb NOT NULL,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(application_id,application_user_id,lesson_session_id,skill),
      FOREIGN KEY(application_id,application_user_id,lesson_session_id)
        REFERENCES product_gotit.private_lesson_sessions(application_id,application_user_id,id) ON DELETE CASCADE
    );
    CREATE INDEX private_lesson_skill_evidence_profile_idx
      ON product_gotit.private_lesson_skill_evidence(application_id,application_user_id,language_code,created_at DESC);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    DROP TABLE product_gotit.private_lesson_skill_evidence;
    DROP TABLE product_gotit.private_lesson_skill_profiles;
    ALTER TABLE product_gotit.user_language_proficiencies
      DROP CONSTRAINT user_language_proficiencies_calibration_target_check,
      DROP CONSTRAINT user_language_proficiencies_estimated_upper_check,
      DROP CONSTRAINT user_language_proficiencies_estimated_lower_check,
      DROP COLUMN calibration_target,
      DROP COLUMN assessment_evidence_count,
      DROP COLUMN estimated_level_upper,
      DROP COLUMN estimated_level_lower;
  `);
};
