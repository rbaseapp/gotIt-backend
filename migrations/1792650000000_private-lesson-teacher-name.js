/**
 * A lesson can be hosted by a character such as Moochi instead of the chosen teacher. Keep the
 * host's name with the lesson, so history and reports name the right tutor and a hosted chat can
 * be told apart from a regular lesson after it ends.
 */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_sessions
      ADD COLUMN IF NOT EXISTS teacher_name varchar(40);
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_sessions
      DROP COLUMN IF EXISTS teacher_name;
  `);
};
