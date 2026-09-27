export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_sessions
      ADD COLUMN correction_mode varchar(24) NOT NULL DEFAULT 'recast'
        CHECK(correction_mode IN ('critical_only','recast','deep_explanation'));
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_sessions
      DROP COLUMN correction_mode;
  `);
};
