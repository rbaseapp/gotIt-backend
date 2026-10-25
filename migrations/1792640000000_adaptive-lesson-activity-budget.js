export const up = (pgm) => {
  pgm.sql(`ALTER TABLE product_gotit.private_lesson_activities
    DROP CONSTRAINT private_lesson_activities_revision_check,
    ADD CONSTRAINT private_lesson_activities_revision_check CHECK(revision BETWEEN 0 AND 1000);`);
};
export const down = (pgm) => {
  // Rehearsal only: never shrink a live session's revision range automatically.
  pgm.sql(`ALTER TABLE product_gotit.private_lesson_activities
    DROP CONSTRAINT private_lesson_activities_revision_check,
    ADD CONSTRAINT private_lesson_activities_revision_check CHECK(revision BETWEEN 0 AND 100);`);
};
