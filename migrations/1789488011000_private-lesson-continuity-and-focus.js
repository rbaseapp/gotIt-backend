export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_sessions
      ADD COLUMN focus_areas jsonb NOT NULL DEFAULT '["speaking","vocabulary"]'::jsonb
        CHECK(jsonb_typeof(focus_areas)='array'),
      ADD COLUMN custom_focus varchar(300),
      ADD COLUMN continuity jsonb
        CHECK(continuity IS NULL OR jsonb_typeof(continuity)='object');
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_sessions
      DROP COLUMN continuity,
      DROP COLUMN custom_focus,
      DROP COLUMN focus_areas;
  `);
};
