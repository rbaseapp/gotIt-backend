import units from './data/english-unique-3000-en-he.json' with { type: 'json' };
import previous from './data/english-communication-en-he.json' with { type: 'json' };
import corrections from './data/english-communication-sense-corrections.json' with { type: 'json' };

const quote = (value) => (value == null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`);
const uuid = (family, number) =>
  `d${family}000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const packIds = units.map(({ number }) => quote(uuid(3, number))).join(',');
const all = units.flatMap((unit) => unit.entries);
if (
  units.length !== 60 ||
  all.length !== 3000 ||
  units.some((unit, i) => unit.number !== i + 1 || unit.entries.length !== 50) ||
  new Set(all.map((entry) => entry.en.toLocaleLowerCase('en'))).size !== 3000 ||
  all.some((entry) => !entry.he || !/[\u05d0-\u05ea]/u.test(entry.he))
)
  throw new Error('Replacement English catalog must contain 3,000 unique translated entries');

const rows = units
  .flatMap((unit, i) =>
    unit.entries.map((entry, j) => {
      const number = i * 50 + j + 1;
      return `(${quote(uuid(4, number))},${quote(previous[i].entries[j].en)},${quote(entry.en)},${quote(entry.en.toLowerCase())},${quote(entry.he)},${quote(entry.he.normalize('NFC'))},${quote(entry.type)},${quote(entry.pos)})`;
    }),
  )
  .join(',\n');
const corrected = new Map(corrections.map(({ unit, en, he }) => [`${unit}/${en}`, he]));
const correctedUnits = new Set(corrections.map(({ unit }) => unit));
const reverseRows = units
  .flatMap((unit, i) =>
    unit.entries.map((entry, j) => {
      const number = i * 50 + j + 1;
      const old = previous[i].entries[j];
      const he = corrected.get(`${unit.number}/${old.en}`) ?? old.he;
      return `(${quote(uuid(4, number))},${quote(entry.en)},${quote(old.en)},${quote(old.en.toLowerCase())},${quote(he)},${quote(he.normalize('NFC'))},${quote(old.type)},${quote(old.pos)})`;
    }),
  )
  .join(',\n');

export const up = (pgm) => {
  pgm.sql(`CREATE TABLE product_gotit.english_catalog_progress_archive (
    kind text NOT NULL CHECK (kind IN ('known','link')),
    application_id uuid NOT NULL,
    application_user_id uuid NOT NULL,
    pack_id uuid NOT NULL,
    entry_id uuid NOT NULL,
    source_text text NOT NULL,
    translation_text text NOT NULL,
    payload jsonb NOT NULL,
    archived_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY(kind,application_id,application_user_id,pack_id,entry_id)
  );`);
  pgm.sql(`DO $$ DECLARE changed integer; BEGIN
    SELECT count(*) INTO changed FROM product_gotit.word_pack_entries e
    JOIN (VALUES ${rows}) AS v(id,previous_source,next_source,next_normalized_source,next_translation,next_normalized_translation,next_type,next_pos)
      ON e.id=v.id::uuid AND e.source_text=v.previous_source;
    IF changed <> 3000 THEN RAISE EXCEPTION 'English catalog source state mismatch: %', changed; END IF;
    SELECT count(*) INTO changed FROM product_gotit.word_packs
      WHERE id IN (${packIds}) AND version IN (2,3);
    IF changed <> 60 THEN RAISE EXCEPTION 'English catalog pack version mismatch: %', changed; END IF;
  END $$;`);
  pgm.sql(`INSERT INTO product_gotit.english_catalog_progress_archive
      (kind,application_id,application_user_id,pack_id,entry_id,source_text,translation_text,payload)
    SELECT 'known',k.application_id,k.application_user_id,k.pack_id,k.entry_id,
      e.source_text,e.translation_text,to_jsonb(k)
    FROM product_gotit.user_word_pack_known_entries k
    JOIN product_gotit.word_pack_entries e ON e.id=k.entry_id
    WHERE k.pack_id IN (${packIds});`);
  pgm.sql(`INSERT INTO product_gotit.english_catalog_progress_archive
      (kind,application_id,application_user_id,pack_id,entry_id,source_text,translation_text,payload)
    SELECT 'link',l.application_id,l.application_user_id,l.pack_id,l.entry_id,
      e.source_text,e.translation_text,to_jsonb(l)
    FROM product_gotit.learning_item_pack_entries l
    JOIN product_gotit.word_pack_entries e ON e.id=l.entry_id
    WHERE l.pack_id IN (${packIds});`);
  pgm.sql(`DELETE FROM product_gotit.user_word_pack_known_entries WHERE pack_id IN (${packIds});`);
  pgm.sql(`DELETE FROM product_gotit.learning_item_pack_entries WHERE pack_id IN (${packIds});`);
  pgm.sql(`UPDATE product_gotit.word_pack_entries
    SET normalized_source_text='__english_unique_migration__'||id::text
    WHERE pack_id IN (${packIds});`);
  pgm.sql(`DO $$ DECLARE changed integer; BEGIN
    WITH revised AS (
      UPDATE product_gotit.word_pack_entries e SET
        source_text=v.next_source,
        normalized_source_text=v.next_normalized_source,
        translation_text=v.next_translation,
        normalized_translation_text=v.next_normalized_translation,
        item_type=v.next_type,
        part_of_speech=v.next_pos,
        updated_at=now()
      FROM (VALUES ${rows}) AS v(id,previous_source,next_source,next_normalized_source,next_translation,next_normalized_translation,next_type,next_pos)
      WHERE e.id=v.id::uuid RETURNING e.id
    ) SELECT count(*) INTO changed FROM revised;
    IF changed <> 3000 THEN RAISE EXCEPTION 'English catalog replacement count mismatch: %', changed; END IF;
  END $$;`);
  for (const unit of units) {
    pgm.sql(`UPDATE product_gotit.word_packs SET title=${quote(`יחידה ${unit.moduleNumber}: ${unit.name}`)},
      version=4,updated_at=now() WHERE id=${quote(uuid(3, unit.number))};`);
  }
  pgm.sql(`UPDATE product_gotit.word_topics SET title='לימוד שפה מאפס',
    description='3,000 מילים וביטויים ייחודיים ב־60 יחידות בשלוש רמות'
    WHERE id=${quote(uuid(1, 1))} AND slug='english-learning-path-en-he';`);
  // A known selection follows the English term, never the reused ordinal entry ID.
  // One new entry exists for each term globally; old selections of removed terms stay archived.
  pgm.sql(`INSERT INTO product_gotit.user_word_pack_known_entries
      (application_id,application_user_id,pack_id,entry_id,known_at)
    SELECT DISTINCT ON (a.application_id,a.application_user_id,e.id)
      a.application_id,a.application_user_id,e.pack_id,e.id,(a.payload->>'known_at')::timestamptz
    FROM product_gotit.english_catalog_progress_archive a
    JOIN product_gotit.word_pack_entries e ON e.pack_id IN (${packIds})
      AND lower(e.source_text)=lower(a.source_text)
      AND e.translation_text=a.translation_text
    WHERE a.kind='known'
    ORDER BY a.application_id,a.application_user_id,e.id,(a.payload->>'known_at')::timestamptz
    ON CONFLICT DO NOTHING;`);
  // Practice links remain attached only when the identical source and translated sense
  // still belong to an installed pack. Every unmatched original is retained in the archive.
  pgm.sql(`INSERT INTO product_gotit.learning_item_pack_entries
      (application_id,application_user_id,pack_id,entry_id,learning_item_id,
       excluded_at,kept_by_user,created_at,updated_at)
    SELECT DISTINCT ON (a.application_id,a.application_user_id,e.pack_id,e.id)
      a.application_id,a.application_user_id,e.pack_id,e.id,
      (a.payload->>'learning_item_id')::uuid,(a.payload->>'excluded_at')::timestamptz,
      (a.payload->>'kept_by_user')::boolean,(a.payload->>'created_at')::timestamptz,
      (a.payload->>'updated_at')::timestamptz
    FROM product_gotit.english_catalog_progress_archive a
    JOIN product_gotit.word_pack_entries e ON e.pack_id=a.pack_id
      AND lower(e.source_text)=lower(a.source_text)
      AND e.translation_text=a.translation_text
    JOIN product_gotit.user_word_packs up ON up.application_id=a.application_id
      AND up.application_user_id=a.application_user_id AND up.pack_id=e.pack_id
    JOIN product_gotit.learning_items li ON li.id=(a.payload->>'learning_item_id')::uuid
      AND li.application_id=a.application_id AND li.application_user_id=a.application_user_id
    WHERE a.kind='link'
    ORDER BY a.application_id,a.application_user_id,e.pack_id,e.id,a.archived_at
    ON CONFLICT DO NOTHING;`);
};

export const down = (pgm) => {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM product_gotit.english_catalog_progress_archive)
      OR EXISTS (SELECT 1 FROM product_gotit.user_word_pack_known_entries WHERE pack_id IN (${packIds}))
      OR EXISTS (SELECT 1 FROM product_gotit.learning_item_pack_entries WHERE pack_id IN (${packIds}))
    THEN RAISE EXCEPTION 'Unique English catalog rollback requires a reviewed restore of user progress'; END IF;
  END $$;`);
  pgm.sql(`UPDATE product_gotit.word_pack_entries
    SET normalized_source_text='__english_unique_rollback__'||id::text
    WHERE pack_id IN (${packIds});`);
  pgm.sql(`DO $$ DECLARE changed integer; BEGIN
    WITH revised AS (
      UPDATE product_gotit.word_pack_entries e SET
        source_text=v.next_source,
        normalized_source_text=v.next_normalized_source,
        translation_text=v.next_translation,
        normalized_translation_text=v.next_normalized_translation,
        item_type=v.next_type,
        part_of_speech=v.next_pos,
        updated_at=now()
      FROM (VALUES ${reverseRows}) AS v(id,previous_source,next_source,next_normalized_source,next_translation,next_normalized_translation,next_type,next_pos)
      WHERE e.id=v.id::uuid AND e.source_text=v.previous_source RETURNING e.id
    ) SELECT count(*) INTO changed FROM revised;
    IF changed <> 3000 THEN RAISE EXCEPTION 'English catalog rollback count mismatch: %', changed; END IF;
  END $$;`);
  for (const unit of previous) {
    pgm.sql(`UPDATE product_gotit.word_packs SET title=${quote(`יחידה ${unit.moduleNumber}: ${unit.name}`)},
      version=${correctedUnits.has(unit.number) ? 3 : 2},updated_at=now()
      WHERE id=${quote(uuid(3, unit.number))} AND version=4;`);
  }
  pgm.sql(`UPDATE product_gotit.word_topics SET title='מסלול לימוד אנגלית',
    description='לימוד אנגלית מעברית בשלוש רמות מדורגות וביחידות של 50 מילים וביטויים'
    WHERE id=${quote(uuid(1, 1))} AND slug='english-learning-path-en-he';`);
  pgm.sql('DROP TABLE product_gotit.english_catalog_progress_archive');
};
