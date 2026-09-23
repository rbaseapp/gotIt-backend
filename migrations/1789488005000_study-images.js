export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.learning_items
      ADD COLUMN study_image_data bytea,
      ADD COLUMN study_image_content_type text,
      ADD COLUMN study_image_model text,
      ADD COLUMN study_image_revision integer,
      ADD CONSTRAINT learning_items_study_image_complete CHECK(
        (study_image_data IS NULL AND study_image_content_type IS NULL
          AND study_image_model IS NULL AND study_image_revision IS NULL)
        OR
        (study_image_data IS NOT NULL
          AND octet_length(study_image_data) BETWEEN 1 AND 3000000
          AND study_image_content_type='image/webp'
          AND length(study_image_model) BETWEEN 1 AND 200
          AND study_image_revision>0)
      );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.learning_items
      DROP CONSTRAINT learning_items_study_image_complete,
      DROP COLUMN study_image_revision,
      DROP COLUMN study_image_model,
      DROP COLUMN study_image_content_type,
      DROP COLUMN study_image_data;
  `);
};
