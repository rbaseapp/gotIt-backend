export const up = (pgm) =>
  pgm.sql(`
  ALTER TABLE product_gotit.lexical_concepts
    ADD COLUMN meaning_revision integer NOT NULL DEFAULT 1 CHECK(meaning_revision>0),
    ADD COLUMN origin text NOT NULL DEFAULT 'manual' CHECK(origin IN ('manual','ai')),
    ADD COLUMN canonical_lemma text,
    ADD COLUMN canonical_pos text;
  CREATE FUNCTION product_gotit.concept_search_text(language_code text, expression text)
    RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
    SELECT CASE split_part(lower(language_code),'-',1)
      WHEN 'ar' THEN regexp_replace(expression,'[ـً-ٰٟۖ-ۭ]','','g')
      WHEN 'he' THEN regexp_replace(expression,'[֑-ׇֽֿׁׂׅׄ]','','g')
      ELSE expression END
  $$;
  ALTER TABLE product_gotit.concept_expressions ADD COLUMN search_text text
    GENERATED ALWAYS AS (product_gotit.concept_search_text(language_code,normalized_text)) STORED;
  CREATE INDEX concept_expression_semantic_lookup ON product_gotit.concept_expressions(application_id,language_code,search_text,concept_id);
  CREATE INDEX concept_canonical_lemma_lookup ON product_gotit.lexical_concepts(application_id,canonical_lemma,canonical_pos) WHERE status='active';
  CREATE INDEX concept_definition_search ON product_gotit.lexical_concepts USING gin(to_tsvector('simple',definition||' '||title)) WHERE status='active';

  CREATE TABLE product_gotit.concept_assignment_jobs (
    application_id uuid NOT NULL,application_user_id uuid NOT NULL,learning_item_id uuid NOT NULL,
    learning_revision integer NOT NULL,generation integer NOT NULL DEFAULT 1 CHECK(generation>0),priority integer NOT NULL DEFAULT 10,
    status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed')),
    claim_id uuid,claim_until timestamptz,attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),last_error text,
    descriptor jsonb,updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(application_id,application_user_id,learning_item_id),
    FOREIGN KEY(application_id,application_user_id,learning_item_id)
      REFERENCES product_gotit.learning_items(application_id,application_user_id,id) ON DELETE CASCADE
  );
  CREATE INDEX concept_assignment_due ON product_gotit.concept_assignment_jobs(priority DESC,next_attempt_at,updated_at) WHERE status<>'completed';
  CREATE TABLE product_gotit.learning_item_concepts (
    application_id uuid NOT NULL,application_user_id uuid NOT NULL,learning_item_id uuid NOT NULL,
    learning_revision integer NOT NULL,job_generation integer NOT NULL,
    concept_id uuid NOT NULL,meaning_revision integer NOT NULL,
    provider_model text NOT NULL,decision text NOT NULL CHECK(decision IN ('matched','created')),
    assigned_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(application_id,application_user_id,learning_item_id),
    FOREIGN KEY(application_id,application_user_id,learning_item_id)
      REFERENCES product_gotit.learning_items(application_id,application_user_id,id) ON DELETE CASCADE,
    FOREIGN KEY(application_id,concept_id) REFERENCES product_gotit.lexical_concepts(application_id,id)
  );
  CREATE INDEX learning_item_concept_meaning ON product_gotit.learning_item_concepts(application_id,concept_id,meaning_revision);

  CREATE FUNCTION product_gotit.enqueue_item_concept(app uuid,usr uuid,item uuid)
    RETURNS void LANGUAGE sql SET search_path=pg_catalog,product_gotit AS $$
    INSERT INTO product_gotit.concept_assignment_jobs(application_id,application_user_id,learning_item_id,learning_revision)
      SELECT application_id,application_user_id,id,learning_revision FROM product_gotit.learning_items
      WHERE application_id=app AND application_user_id=usr AND id=item AND deleted_at IS NULL
    ON CONFLICT(application_id,application_user_id,learning_item_id) DO UPDATE SET
      learning_revision=EXCLUDED.learning_revision,generation=concept_assignment_jobs.generation+1,priority=10,
      status='pending',claim_id=NULL,claim_until=NULL,attempts=0,descriptor=NULL,last_error=NULL,next_attempt_at=now(),updated_at=now()
  $$;
  CREATE FUNCTION product_gotit.queue_learning_item_concept() RETURNS trigger
    LANGUAGE plpgsql SET search_path=pg_catalog,product_gotit AS $$ BEGIN
      IF TG_OP='INSERT' OR ROW(NEW.source_text,NEW.source_language_code,NEW.translation_language_code,NEW.part_of_speech,NEW.learning_revision,NEW.deleted_at)
        IS DISTINCT FROM ROW(OLD.source_text,OLD.source_language_code,OLD.translation_language_code,OLD.part_of_speech,OLD.learning_revision,OLD.deleted_at)
      THEN
        IF NEW.deleted_at IS NULL THEN PERFORM product_gotit.enqueue_item_concept(NEW.application_id,NEW.application_user_id,NEW.id);
        ELSE DELETE FROM product_gotit.concept_assignment_jobs WHERE application_id=NEW.application_id AND application_user_id=NEW.application_user_id AND learning_item_id=NEW.id; END IF;
      END IF; RETURN NEW;
    END $$;
  CREATE TRIGGER queue_learning_item_concept AFTER INSERT OR UPDATE OF source_text,source_language_code,translation_language_code,part_of_speech,learning_revision,deleted_at
    ON product_gotit.learning_items FOR EACH ROW EXECUTE FUNCTION product_gotit.queue_learning_item_concept();
  CREATE FUNCTION product_gotit.queue_translation_concept() RETURNS trigger
    LANGUAGE plpgsql SET search_path=pg_catalog,product_gotit AS $$ BEGIN
      IF TG_OP<>'INSERT' AND OLD.is_primary AND OLD.is_current THEN
        PERFORM product_gotit.enqueue_item_concept(OLD.application_id,OLD.application_user_id,OLD.learning_item_id);
      ELSIF TG_OP<>'DELETE' AND NEW.is_primary AND NEW.is_current THEN
        PERFORM product_gotit.enqueue_item_concept(NEW.application_id,NEW.application_user_id,NEW.learning_item_id);
      END IF; RETURN NULL;
    END $$;
  CREATE TRIGGER queue_translation_concept AFTER INSERT OR UPDATE OF translation_text,is_primary,is_current OR DELETE
    ON product_gotit.item_translations FOR EACH ROW EXECUTE FUNCTION product_gotit.queue_translation_concept();
  CREATE FUNCTION product_gotit.revise_concept_meaning() RETURNS trigger
    LANGUAGE plpgsql SET search_path=pg_catalog,product_gotit AS $$ BEGIN
      IF ROW(NEW.definition,NEW.status) IS DISTINCT FROM ROW(OLD.definition,OLD.status) THEN
        NEW.meaning_revision=OLD.meaning_revision+1;
      ELSE NEW.meaning_revision=OLD.meaning_revision; END IF; RETURN NEW;
    END $$;
  CREATE TRIGGER revise_concept_meaning BEFORE UPDATE ON product_gotit.lexical_concepts
    FOR EACH ROW EXECUTE FUNCTION product_gotit.revise_concept_meaning();
  CREATE FUNCTION product_gotit.requeue_concept_meaning() RETURNS trigger
    LANGUAGE plpgsql SET search_path=pg_catalog,product_gotit AS $$ DECLARE item record; BEGIN
      IF NEW.meaning_revision<>OLD.meaning_revision THEN
        FOR item IN SELECT * FROM product_gotit.learning_item_concepts WHERE application_id=NEW.application_id AND concept_id=NEW.id
        LOOP PERFORM product_gotit.enqueue_item_concept(item.application_id,item.application_user_id,item.learning_item_id); END LOOP;
      END IF; RETURN NULL;
    END $$;
  CREATE TRIGGER requeue_concept_meaning AFTER UPDATE ON product_gotit.lexical_concepts
    FOR EACH ROW EXECUTE FUNCTION product_gotit.requeue_concept_meaning();
  -- Durable bounded worker backfill also includes words saved before this release.
  INSERT INTO product_gotit.concept_assignment_jobs(application_id,application_user_id,learning_item_id,learning_revision,priority)
    SELECT application_id,application_user_id,id,learning_revision,0 FROM product_gotit.learning_items WHERE deleted_at IS NULL;
`);

export const down = (pgm) =>
  pgm.sql(`
  DO $$ BEGIN IF EXISTS(SELECT 1 FROM product_gotit.learning_item_concepts)
    OR EXISTS(SELECT 1 FROM product_gotit.concept_assignment_jobs WHERE attempts>0)
    THEN RAISE EXCEPTION 'Automatic concept work exists; retain schema and roll back application code'; END IF; END $$;
  DROP TRIGGER requeue_concept_meaning ON product_gotit.lexical_concepts;
  DROP TRIGGER revise_concept_meaning ON product_gotit.lexical_concepts;
  DROP TRIGGER queue_translation_concept ON product_gotit.item_translations;
  DROP TRIGGER queue_learning_item_concept ON product_gotit.learning_items;
  DROP FUNCTION product_gotit.requeue_concept_meaning(),product_gotit.revise_concept_meaning(),product_gotit.queue_translation_concept(),product_gotit.queue_learning_item_concept(),product_gotit.enqueue_item_concept(uuid,uuid,uuid);
  DROP TABLE product_gotit.learning_item_concepts,product_gotit.concept_assignment_jobs;
  ALTER TABLE product_gotit.concept_expressions DROP COLUMN search_text;
  DROP FUNCTION product_gotit.concept_search_text(text,text);
  DROP INDEX product_gotit.concept_definition_search;
  ALTER TABLE product_gotit.lexical_concepts DROP COLUMN meaning_revision,DROP COLUMN origin,DROP COLUMN canonical_lemma,DROP COLUMN canonical_pos;
`);
