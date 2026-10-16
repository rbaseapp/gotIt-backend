export const up = (pgm) =>
  pgm.sql(`
  CREATE FUNCTION product_gotit.resolve_image_concept(app uuid, sl text, st text, tl text, tt text)
  RETURNS TABLE(concept_id uuid, ambiguous boolean)
  LANGUAGE sql STABLE AS $$
    WITH reviewed AS (
      SELECT c.id,
        EXISTS(SELECT 1 FROM product_gotit.concept_expressions e WHERE e.application_id=app AND e.concept_id=c.id AND e.language_code=sl AND e.normalized_text=st) source_match,
        EXISTS(SELECT 1 FROM product_gotit.concept_expressions e WHERE e.application_id=app AND e.concept_id=c.id AND e.language_code=tl AND e.normalized_text=tt) translation_match,
        EXISTS(SELECT 1 FROM product_gotit.concept_expressions e WHERE e.application_id=app AND e.concept_id=c.id AND e.language_code=sl) source_known,
        EXISTS(SELECT 1 FROM product_gotit.concept_expressions e WHERE e.application_id=app AND e.concept_id=c.id AND e.language_code=tl) translation_known
      FROM product_gotit.lexical_concepts c
      WHERE c.application_id=app AND c.status='active' AND c.automatic_identity IS NULL
        AND sl IS NOT NULL AND st<>'' AND tl IS NOT NULL AND tt<>''
    ), matches AS (
      SELECT array_agg(id ORDER BY id) FILTER(WHERE source_match AND translation_match) exact,
        array_agg(id ORDER BY id) FILTER(WHERE
          (source_match AND NOT translation_known) OR (translation_match AND NOT source_known)) bridge
      FROM reviewed
    ), selected AS (
      SELECT CASE WHEN cardinality(exact)=1 THEN exact[1]
        WHEN exact IS NULL AND cardinality(bridge)=1 THEN bridge[1] END id,
        cardinality(exact)>1 OR (exact IS NULL AND cardinality(bridge)>1) uncertain
      FROM matches
    )
    SELECT COALESCE(selected.id, automatic.id),
      COALESCE(selected.uncertain,false) AND automatic.id IS NULL
    FROM selected LEFT JOIN product_gotit.lexical_concepts automatic
      ON automatic.application_id=app AND automatic.status='active'
      AND automatic.automatic_identity=product_gotit.word_image_identity(sl,st,tl,tt)
  $$;
`);

export const down = (pgm) =>
  pgm.sql('DROP FUNCTION product_gotit.resolve_image_concept(uuid,text,text,text,text)');
