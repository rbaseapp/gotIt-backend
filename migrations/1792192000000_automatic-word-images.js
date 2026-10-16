// Derive image identities from recorded translations, never from spelling alone.
export const up = (pgm) =>
  pgm.sql(`
  ALTER TABLE product_gotit.lexical_concepts ADD COLUMN automatic_identity jsonb;
  CREATE UNIQUE INDEX concept_automatic_identity ON product_gotit.lexical_concepts(application_id,automatic_identity) WHERE automatic_identity IS NOT NULL;
  CREATE FUNCTION product_gotit.word_image_identity(sl text,st text,tl text,tt text) RETURNS jsonb
    LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT jsonb_agg(jsonb_build_array(lang,word) ORDER BY lang COLLATE "C",word COLLATE "C")
    FROM (SELECT DISTINCT lang,trim(regexp_replace(lower(normalize(word,NFKC)),'\\s+',' ','g')) word FROM (VALUES(sl,st),(tl,tt)) forms(lang,word)
      WHERE lang IS NOT NULL AND word IS NOT NULL AND word<>'') unique_forms
  $$;
  CREATE TEMP TABLE word_image_backfill ON COMMIT DROP AS
  SELECT DISTINCT ON(application_id,identity) * FROM (
    SELECT li.application_id,product_gotit.word_image_identity(li.source_language_code,li.normalized_source_text,li.translation_language_code,tr.normalized_text) identity,
      li.source_language_code sl,li.source_text st,li.normalized_source_text ns,li.translation_language_code tl,tr.translation_text tt,tr.normalized_text nt
    FROM product_gotit.learning_items li LEFT JOIN LATERAL(SELECT * FROM product_gotit.item_translations t WHERE t.application_id=li.application_id AND t.application_user_id=li.application_user_id AND t.learning_item_id=li.id AND t.is_primary AND t.is_current LIMIT 1) tr ON true
    UNION ALL
    SELECT apps.application_id,product_gotit.word_image_identity(a.source_language_code,a.normalized_source_text,a.translation_language_code,a.normalized_translation_text),
      a.source_language_code,a.normalized_source_text,a.normalized_source_text,a.translation_language_code,a.normalized_translation_text,a.normalized_translation_text
    FROM product_gotit.study_image_assets a CROSS JOIN(SELECT DISTINCT application_id FROM product_gotit.user_profiles) apps
  ) pairs ORDER BY application_id,identity;
  ALTER TABLE word_image_backfill ADD COLUMN concept_id uuid;
  -- Preserve one existing reviewed meaning. Ambiguity gets its own exact pair.
  UPDATE word_image_backfill b SET concept_id=matched.ids[1] FROM (
    SELECT b.application_id,b.identity,array_agg(c.id ORDER BY c.id) ids FROM word_image_backfill b
    JOIN product_gotit.lexical_concepts c ON c.application_id=b.application_id AND c.status='active'
    WHERE b.nt IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b.identity) node WHERE NOT EXISTS(
      SELECT 1 FROM product_gotit.concept_expressions e WHERE e.application_id=c.application_id AND e.concept_id=c.id AND e.language_code=node->>0 AND e.normalized_text=node->>1))
    GROUP BY b.application_id,b.identity HAVING count(*)=1
  ) matched WHERE b.application_id=matched.application_id AND b.identity=matched.identity;
  INSERT INTO product_gotit.lexical_concepts(application_id,key,title,definition,visual_description,stock_search_query,automatic_identity)
  SELECT application_id,'auto-'||gen_random_uuid(),left(st||COALESCE(' / '||tt,''),200),
    left(st||COALESCE(' means '||tt,'')||' ('||sl||COALESCE(' / '||tl,'')||')',1000),
    left('One clear depiction of '||st||COALESCE(', meaning '||tt,'')||', plain background, no text or logos.',500),
    CASE WHEN sl='en' AND st ~ '^[a-zA-Z0-9 ,''-]+$' THEN left(st,100) WHEN tl='en' AND tt ~ '^[a-zA-Z0-9 ,''-]+$' THEN left(tt,100) ELSE '' END,identity
  FROM word_image_backfill WHERE concept_id IS NULL;
  UPDATE word_image_backfill b SET concept_id=c.id FROM product_gotit.lexical_concepts c WHERE b.concept_id IS NULL AND c.application_id=b.application_id AND c.automatic_identity=b.identity;
  INSERT INTO product_gotit.concept_expressions(application_id,concept_id,language_code,expression,normalized_text)
    SELECT application_id,concept_id,sl,left(st,300),trim(regexp_replace(lower(normalize(ns,NFKC)),'\\s+',' ','g')) FROM word_image_backfill
    UNION SELECT application_id,concept_id,tl,left(tt,300),trim(regexp_replace(lower(normalize(nt,NFKC)),'\\s+',' ','g')) FROM word_image_backfill WHERE nt IS NOT NULL
    ON CONFLICT DO NOTHING;
  -- Reuse current saved bytes. Do not generate, reset or discard an existing image.
  INSERT INTO product_gotit.concept_image_assets(application_id,concept_id,image_revision,claim_id,claim_until,image_data,image_content_type,image_kind,image_provider,image_model,image_source_url,image_creator)
  SELECT DISTINCT ON(b.application_id,b.concept_id) b.application_id,b.concept_id,c.image_revision,gen_random_uuid(),'epoch',i.image_data,i.content_type,i.kind,i.provider,i.model,i.source_url,i.creator
  FROM word_image_backfill b JOIN product_gotit.lexical_concepts c ON c.application_id=b.application_id AND c.id=b.concept_id
  CROSS JOIN LATERAL(
    SELECT li.study_image_data image_data,li.study_image_content_type content_type,li.study_image_kind kind,li.study_image_provider provider,li.study_image_model model,li.study_image_source_url source_url,li.study_image_creator creator,li.updated_at stamp,0 priority
    FROM product_gotit.learning_items li JOIN product_gotit.item_translations tr ON tr.application_id=li.application_id AND tr.application_user_id=li.application_user_id AND tr.learning_item_id=li.id AND tr.is_primary AND tr.is_current
    WHERE li.application_id=b.application_id AND product_gotit.word_image_identity(li.source_language_code,li.normalized_source_text,li.translation_language_code,tr.normalized_text)=b.identity AND li.study_image_revision=li.learning_revision AND li.study_image_data IS NOT NULL
    UNION ALL
    SELECT a.image_data,a.image_content_type,a.image_kind,a.image_provider,a.image_model,a.image_source_url,a.image_creator,a.created_at,1 FROM product_gotit.study_image_assets a
    WHERE product_gotit.word_image_identity(a.source_language_code,a.normalized_source_text,a.translation_language_code,a.normalized_translation_text)=b.identity
  ) i ORDER BY b.application_id,b.concept_id,i.priority,i.stamp DESC
  ON CONFLICT DO NOTHING;
`);
export const down = (pgm) =>
  pgm.sql(`
  DO $$ BEGIN IF EXISTS(SELECT 1 FROM product_gotit.lexical_concepts WHERE automatic_identity IS NOT NULL)
    THEN RAISE EXCEPTION 'Automatic image identities exist; retain additive schema when rolling back code'; END IF; END $$;
  DROP FUNCTION product_gotit.word_image_identity(text,text,text,text);
  ALTER TABLE product_gotit.lexical_concepts DROP COLUMN automatic_identity;
`);
