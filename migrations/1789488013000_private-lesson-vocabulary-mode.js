export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_sessions
      ADD COLUMN vocabulary_mode varchar(16) NOT NULL DEFAULT 'learned'
        CHECK(vocabulary_mode IN ('learned','none'));
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_sessions
      DROP COLUMN vocabulary_mode;
  `);
};
