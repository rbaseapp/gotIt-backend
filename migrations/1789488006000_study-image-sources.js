export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.learning_items
      DROP CONSTRAINT learning_items_study_image_complete,
      ADD COLUMN study_image_kind text,
      ADD COLUMN study_image_provider text,
      ADD COLUMN study_image_source_url text,
      ADD COLUMN study_image_creator text;

    UPDATE product_gotit.learning_items
      SET study_image_kind='generated',study_image_provider='OpenAI'
      WHERE study_image_data IS NOT NULL;

    ALTER TABLE product_gotit.learning_items
      ADD CONSTRAINT learning_items_study_image_complete CHECK(
        (study_image_data IS NULL AND study_image_content_type IS NULL
          AND study_image_model IS NULL AND study_image_revision IS NULL
          AND study_image_kind IS NULL AND study_image_provider IS NULL
          AND study_image_source_url IS NULL AND study_image_creator IS NULL)
        OR
        (study_image_data IS NOT NULL
          AND octet_length(study_image_data) BETWEEN 1 AND 3000000
          AND study_image_content_type IN ('image/jpeg','image/png','image/webp')
          AND length(study_image_model) BETWEEN 1 AND 200
          AND study_image_revision>0
          AND study_image_kind IN ('generated','stock')
          AND length(study_image_provider) BETWEEN 1 AND 100
          AND ((study_image_kind='generated' AND study_image_source_url IS NULL
                AND study_image_creator IS NULL)
            OR (study_image_kind='stock'
                AND length(study_image_source_url) BETWEEN 1 AND 2000
                AND (study_image_creator IS NULL
                  OR length(study_image_creator) BETWEEN 1 AND 200))))
      );
  `);
};

export const down = (pgm) => {
  pgm.sql(`
    ALTER TABLE product_gotit.learning_items
      DROP CONSTRAINT learning_items_study_image_complete;

    UPDATE product_gotit.learning_items
      SET study_image_data=NULL,study_image_content_type=NULL,study_image_model=NULL,
          study_image_revision=NULL
      WHERE study_image_content_type IS NOT NULL AND study_image_content_type<>'image/webp';

    ALTER TABLE product_gotit.learning_items
      DROP COLUMN study_image_creator,
      DROP COLUMN study_image_source_url,
      DROP COLUMN study_image_provider,
      DROP COLUMN study_image_kind,
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
