export const up = (pgm) =>
  pgm.sql(`
  CREATE TABLE product_gotit.lexical_concepts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), application_id uuid NOT NULL,
    key text NOT NULL CHECK(length(key) BETWEEN 1 AND 80),
    title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
    definition text NOT NULL CHECK(length(definition) BETWEEN 1 AND 1000),
    visual_description text NOT NULL CHECK(length(visual_description) BETWEEN 1 AND 500),
    stock_search_query text NOT NULL DEFAULT '' CHECK(length(stock_search_query)<=100),
    status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
    revision integer NOT NULL DEFAULT 0 CHECK(revision>=0),
    image_revision integer NOT NULL DEFAULT 1 CHECK(image_revision>0),
    is_seed boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(application_id,id), UNIQUE(application_id,key)
  );
  CREATE TABLE product_gotit.concept_expressions (
    application_id uuid NOT NULL, concept_id uuid NOT NULL,
    language_code text NOT NULL CHECK(length(language_code) BETWEEN 1 AND 64),
    expression text NOT NULL CHECK(length(expression) BETWEEN 1 AND 300),
    normalized_text text NOT NULL CHECK(length(normalized_text) BETWEEN 1 AND 300),
    PRIMARY KEY(application_id,concept_id,language_code,normalized_text),
    FOREIGN KEY(application_id,concept_id) REFERENCES product_gotit.lexical_concepts(application_id,id) ON DELETE CASCADE
  );
  CREATE INDEX concept_expression_lookup ON product_gotit.concept_expressions(application_id,language_code,normalized_text,concept_id);
  CREATE TABLE product_gotit.concept_image_assets (
    application_id uuid NOT NULL, concept_id uuid NOT NULL, image_revision integer NOT NULL CHECK(image_revision>0),
    claim_id uuid NOT NULL, claim_until timestamptz NOT NULL,
    image_data bytea, image_content_type text, image_kind text, image_provider text,
    image_model text, image_source_url text, image_creator text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(application_id,concept_id,image_revision),
    FOREIGN KEY(application_id,concept_id) REFERENCES product_gotit.lexical_concepts(application_id,id) ON DELETE CASCADE,
    CHECK(image_data IS NULL OR (
      octet_length(image_data) BETWEEN 1 AND 3000000 AND image_content_type IS NOT NULL
      AND image_content_type IN ('image/jpeg','image/png','image/webp')
      AND image_kind IS NOT NULL AND image_kind IN ('generated','stock')
      AND image_provider IS NOT NULL AND length(image_provider) BETWEEN 1 AND 100
      AND image_model IS NOT NULL AND length(image_model) BETWEEN 1 AND 200
      AND (image_kind='generated' OR (image_source_url IS NOT NULL AND image_source_url LIKE 'https://%'))
    ))
  );
  -- One reviewed starter sense. More senses and languages are managed by staff.
  INSERT INTO product_gotit.lexical_concepts(application_id,key,title,definition,visual_description,stock_search_query,is_seed)
    SELECT DISTINCT application_id,'apple-fruit','תפוח / Apple','The edible fruit of an apple tree; not a company or device.',
      'One whole red apple fruit, isolated on a plain background, no text or logos.','apple fruit isolated',true
    FROM product_gotit.user_profiles;
  INSERT INTO product_gotit.concept_expressions(application_id,concept_id,language_code,expression,normalized_text)
    SELECT c.application_id,c.id,v.lang,v.word,v.word FROM product_gotit.lexical_concepts c
    CROSS JOIN (VALUES ('en','apple'),('he','תפוח'),('ar','تفاح'),('ar','تفاحة'),('yi','עפּל'),
      ('de','apfel'),('fr','pomme'),('es','manzana'),('ru','яблоко'),('zh','苹果')) v(lang,word)
    WHERE c.key='apple-fruit';
`);

export const down = (pgm) =>
  pgm.sql(`
  DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM product_gotit.lexical_concepts WHERE NOT is_seed OR revision>0)
      OR EXISTS(SELECT 1 FROM product_gotit.concept_image_assets)
    THEN RAISE EXCEPTION 'Authored concepts or image work exist; retain schema and roll back application code'; END IF;
  END $$;
  DROP TABLE product_gotit.concept_image_assets,product_gotit.concept_expressions,product_gotit.lexical_concepts;
`);
