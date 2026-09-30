export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_sessions
      ADD COLUMN teaching_language varchar(16) NOT NULL DEFAULT 'target'
      CHECK(teaching_language IN ('target','support'));
    ALTER TABLE product_gotit.private_lesson_preferences
      ADD COLUMN teaching_language varchar(16) NOT NULL DEFAULT 'target'
      CHECK(teaching_language IN ('target','support'));

    UPDATE product_gotit.private_lesson_sessions
       SET teaching_language='support' WHERE lesson_mode='absolute_beginner';
    UPDATE product_gotit.private_lesson_preferences
       SET teaching_language='support' WHERE lesson_mode='absolute_beginner';
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_preferences DROP COLUMN teaching_language;
    ALTER TABLE product_gotit.private_lesson_sessions DROP COLUMN teaching_language;
  `);
};
