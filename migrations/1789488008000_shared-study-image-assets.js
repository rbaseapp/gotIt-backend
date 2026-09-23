export const up = (pgm) => {
  pgm.sql(`
    CREATE TABLE product_gotit.study_image_assets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_language_code text NOT NULL,
      normalized_source_text text NOT NULL,
      translation_language_code text NOT NULL,
      normalized_translation_text text NOT NULL,
      image_model text NOT NULL,
      sense_key text NOT NULL,
      visual_brief jsonb NOT NULL,
      image_data bytea NOT NULL,
      image_content_type text NOT NULL,
      image_kind text NOT NULL,
      image_provider text NOT NULL,
      image_source_url text,
      image_creator text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT study_image_assets_identity_unique UNIQUE(
        source_language_code,normalized_source_text,
        translation_language_code,normalized_translation_text,image_model
      ),
      CONSTRAINT study_image_assets_image_check CHECK(
        octet_length(image_data) BETWEEN 1 AND 3000000
        AND image_content_type IN ('image/jpeg','image/png','image/webp')
        AND length(image_model) BETWEEN 1 AND 200
        AND length(sense_key) BETWEEN 1 AND 200
        AND image_kind IN ('generated','stock')
        AND length(image_provider) BETWEEN 1 AND 100
        AND ((image_kind='generated' AND image_source_url IS NULL AND image_creator IS NULL)
          OR (image_kind='stock' AND length(image_source_url) BETWEEN 1 AND 2000
            AND (image_creator IS NULL OR length(image_creator) BETWEEN 1 AND 200)))
      )
    );
  `);
};

export const down = (pgm) => {
  pgm.sql('DROP TABLE product_gotit.study_image_assets;');
};
