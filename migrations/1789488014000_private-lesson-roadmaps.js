export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE product_gotit.private_lesson_preferences (
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      target_language_code varchar(35) NOT NULL,
      support_language_code varchar(35),
      requested_duration_minutes smallint NOT NULL DEFAULT 5 CHECK(requested_duration_minutes IN (1,5,10,15)),
      teacher_voice varchar(16) NOT NULL DEFAULT 'female' CHECK(teacher_voice IN ('female','male')),
      speech_rate varchar(16) NOT NULL DEFAULT 'normal' CHECK(speech_rate IN ('slow','normal','fast')),
      correction_mode varchar(24) NOT NULL DEFAULT 'recast' CHECK(correction_mode IN ('critical_only','recast','deep_explanation')),
      vocabulary_mode varchar(16) NOT NULL DEFAULT 'learned' CHECK(vocabulary_mode IN ('learned','none')),
      focus_areas jsonb NOT NULL DEFAULT '["speaking","vocabulary"]'::jsonb,
      custom_focus varchar(300),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(application_id,application_user_id,target_language_code),
      FOREIGN KEY(application_id,application_user_id) REFERENCES product_gotit.user_profiles(application_id,application_user_id) ON DELETE CASCADE
    );

    CREATE TABLE product_gotit.private_lesson_roadmaps (
      id uuid NOT NULL,
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      target_language_code varchar(35) NOT NULL,
      goal_kind varchar(20) NOT NULL CHECK(goal_kind IN ('recommended','communication','grammar')),
      goal_key varchar(80) NOT NULL,
      goal_title varchar(120) NOT NULL,
      recommended_reason varchar(240) NOT NULL,
      status varchar(16) NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed')),
      current_milestone_position smallint NOT NULL DEFAULT 1 CHECK(current_milestone_position BETWEEN 1 AND 5),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      PRIMARY KEY(application_id,application_user_id,id),
      FOREIGN KEY(application_id,application_user_id) REFERENCES product_gotit.user_profiles(application_id,application_user_id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX private_lesson_roadmaps_one_active ON product_gotit.private_lesson_roadmaps(application_id,application_user_id,target_language_code) WHERE status='active';

    CREATE TABLE product_gotit.private_lesson_milestones (
      id uuid NOT NULL,
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      roadmap_id uuid NOT NULL,
      position smallint NOT NULL CHECK(position BETWEEN 1 AND 5),
      milestone_key varchar(40) NOT NULL,
      title varchar(120) NOT NULL,
      description varchar(300) NOT NULL,
      communication_objective varchar(300) NOT NULL,
      grammar_topics jsonb NOT NULL DEFAULT '[]'::jsonb,
      success_criteria jsonb NOT NULL,
      status varchar(16) NOT NULL CHECK(status IN ('locked','current','completed')),
      progress_score smallint NOT NULL DEFAULT 0 CHECK(progress_score BETWEEN 0 AND 100),
      evidence_lesson_count integer NOT NULL DEFAULT 0 CHECK(evidence_lesson_count >= 0),
      completed_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(application_id,application_user_id,id),
      UNIQUE(application_id,application_user_id,roadmap_id,position),
      FOREIGN KEY(application_id,application_user_id,roadmap_id) REFERENCES product_gotit.private_lesson_roadmaps(application_id,application_user_id,id) ON DELETE CASCADE
    );

    CREATE TABLE product_gotit.private_lesson_milestone_evidence (
      application_id uuid NOT NULL,
      application_user_id uuid NOT NULL,
      milestone_id uuid NOT NULL,
      lesson_session_id uuid NOT NULL,
      score smallint NOT NULL CHECK(score BETWEEN 0 AND 100),
      confidence varchar(12) NOT NULL CHECK(confidence IN ('low','medium','high')),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(application_id,application_user_id,milestone_id,lesson_session_id),
      UNIQUE(application_id,application_user_id,lesson_session_id),
      FOREIGN KEY(application_id,application_user_id,milestone_id) REFERENCES product_gotit.private_lesson_milestones(application_id,application_user_id,id) ON DELETE CASCADE,
      FOREIGN KEY(application_id,application_user_id,lesson_session_id) REFERENCES product_gotit.private_lesson_sessions(application_id,application_user_id,id) ON DELETE CASCADE
    );

    ALTER TABLE product_gotit.private_lesson_sessions ADD COLUMN roadmap_id uuid, ADD COLUMN milestone_id uuid;
    ALTER TABLE product_gotit.private_lesson_sessions ADD CONSTRAINT private_lesson_sessions_roadmap_fk FOREIGN KEY(application_id,application_user_id,roadmap_id) REFERENCES product_gotit.private_lesson_roadmaps(application_id,application_user_id,id);
    ALTER TABLE product_gotit.private_lesson_sessions ADD CONSTRAINT private_lesson_sessions_milestone_fk FOREIGN KEY(application_id,application_user_id,milestone_id) REFERENCES product_gotit.private_lesson_milestones(application_id,application_user_id,id);
    CREATE INDEX private_lesson_sessions_milestone_idx ON product_gotit.private_lesson_sessions(application_id,application_user_id,milestone_id);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_sessions DROP CONSTRAINT private_lesson_sessions_milestone_fk, DROP CONSTRAINT private_lesson_sessions_roadmap_fk, DROP COLUMN milestone_id, DROP COLUMN roadmap_id;
    DROP TABLE product_gotit.private_lesson_milestone_evidence;
    DROP TABLE product_gotit.private_lesson_milestones;
    DROP TABLE product_gotit.private_lesson_roadmaps;
    DROP TABLE product_gotit.private_lesson_preferences;
  `);
};
