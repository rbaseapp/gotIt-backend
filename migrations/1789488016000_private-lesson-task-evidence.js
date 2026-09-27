export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_milestone_evidence
      ADD COLUMN task_completed boolean NOT NULL DEFAULT false;
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.private_lesson_milestone_evidence
      DROP COLUMN task_completed;
  `);
};
