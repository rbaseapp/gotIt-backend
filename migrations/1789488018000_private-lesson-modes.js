export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_sessions
      ADD COLUMN lesson_mode varchar(24) NOT NULL DEFAULT 'standard'
      CHECK(lesson_mode IN ('standard','absolute_beginner'));

    ALTER TABLE product_gotit.private_lesson_preferences
      ADD COLUMN lesson_mode varchar(24) NOT NULL DEFAULT 'standard'
      CHECK(lesson_mode IN ('standard','absolute_beginner'));
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_preferences DROP COLUMN lesson_mode;
    ALTER TABLE product_gotit.private_lesson_sessions DROP COLUMN lesson_mode;
  `);
};
