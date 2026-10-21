export const up = (pgm) => {
  pgm.sql(`ALTER TABLE product_gotit.learning_documents
    DROP CONSTRAINT learning_documents_kind_check,
    ADD CONSTRAINT learning_documents_kind_check CHECK(kind IN ('course','homework','unit_path'));
    CREATE INDEX learning_documents_unit_path ON product_gotit.learning_documents
      (application_id,application_user_id,(document->>'packId')) WHERE kind='unit_path';`);
};
export const down = (pgm) => {
  // Rehearsal only. Refuse to discard saved learner choices during rollback.
  pgm.sql(`DROP INDEX product_gotit.learning_documents_unit_path;
    ALTER TABLE product_gotit.learning_documents DROP CONSTRAINT learning_documents_kind_check,
    ADD CONSTRAINT learning_documents_kind_check CHECK(kind IN ('course','homework'));`);
};
