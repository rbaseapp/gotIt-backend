import units from './data/english-communication-en-he.json' with { type: 'json' };
import oldTiers from './data/daily-english-en-he.json' with { type: 'json' };
import corrections from './data/english-learning-corrections.json' with { type: 'json' };

const uuid = (family, number) =>
  `d${family}000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const sql = (value) => (value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`);
const correctionByNumber = new Map(corrections.map(({ number, after }) => [number, after]));
const originalTitles = ['אנגלית בסיסית', 'אנגלית טובה', 'אנגלית מתקדמת'];
const packIds = units.map(({ number }) => sql(uuid(3, number))).join(',');

if (
  units.length !== 60 ||
  units.some(
    (unit, index) =>
      unit.number !== index + 1 ||
      unit.moduleNumber !== (index % 20) + 1 ||
      unit.levelCode !== ['beginner', 'intermediate', 'advanced'][Math.floor(index / 20)] ||
      !unit.name ||
      unit.entries.length !== 50 ||
      unit.entries.some((entry) => !entry.en || !entry.he) ||
      new Set(unit.entries.map((entry) => `${entry.en.toLowerCase()}\0${entry.he}`)).size !== 50,
  ) ||
  oldTiers.length !== 3 ||
  oldTiers.some((tier) => tier.length !== 1000)
)
  throw new Error('English communication catalog must contain 60 named units of 50 entries');

const guarded = (pgm) => {
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM product_gotit.user_word_packs WHERE pack_id IN (${packIds}))
       OR EXISTS (SELECT 1 FROM product_gotit.learning_item_pack_entries WHERE pack_id IN (${packIds}))
       OR EXISTS (SELECT 1 FROM product_gotit.user_word_pack_known_entries WHERE pack_id IN (${packIds}))
    THEN RAISE EXCEPTION 'Cannot replace English catalog with saved user progress';
    END IF;
  END $$;`);
};

const updateUnit = (pgm, unit, index, reverse) => {
  const packId = uuid(3, unit.number);
  const oldEntries = oldTiers[Math.floor(index / 20)].slice(
    (index % 20) * 50,
    (index % 20) * 50 + 50,
  );
  const oldTitle = `יחידה ${unit.moduleNumber}: ${originalTitles[Math.floor(index / 20)]}`;
  const newTitle = `יחידה ${unit.moduleNumber}: ${unit.name}`;
  const beforeVersion = reverse ? 2 : 1;
  const afterVersion = reverse ? 1 : 2;
  const beforeTitle = reverse ? newTitle : oldTitle;
  const afterTitle = reverse ? oldTitle : newTitle;
  pgm.sql(`DO $$ DECLARE changed integer; BEGIN
    UPDATE product_gotit.word_packs
    SET title=${sql(afterTitle)},version=${afterVersion},updated_at=now()
    WHERE id=${sql(packId)} AND title=${sql(beforeTitle)} AND version=${beforeVersion};
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> 1 THEN RAISE EXCEPTION 'English unit ${unit.number} pack state mismatch'; END IF;
  END $$;`);
  const rows = unit.entries
    .map((entry, entryIndex) => {
      const number = index * 50 + entryIndex + 1;
      const old = oldEntries[entryIndex];
      const original = {
        en: old.en,
        he: correctionByNumber.get(number) ?? old.he,
        type: old.type,
        pos: old.pos,
      };
      const from = reverse ? entry : original;
      const to = reverse ? original : entry;
      return `(${sql(uuid(4, number))},${sql(from.en)},${sql(to.en)},${sql(to.en.toLowerCase())},${sql(to.he)},${sql(to.he.normalize('NFC'))},${sql(to.type)},${sql(to.pos)})`;
    })
    .join(',\n');
  // Move current identities aside first so an exchange of two entries cannot
  // violate the immediate unique(pack_id, normalized_source_text, translation) key.
  pgm.sql(`UPDATE product_gotit.word_pack_entries
    SET normalized_source_text='__english_catalog_migration__'||id::text
    WHERE pack_id=${sql(packId)};`);
  pgm.sql(`DO $$ DECLARE changed integer; BEGIN
    WITH replaced AS (
      UPDATE product_gotit.word_pack_entries e
      SET source_text=v.next_source,
          normalized_source_text=v.next_normalized_source,
          translation_text=v.next_translation,
          normalized_translation_text=v.next_normalized_translation,
          item_type=v.next_type,
          part_of_speech=v.next_pos,
          updated_at=now()
      FROM (VALUES ${rows}) AS v(id,previous_source,next_source,next_normalized_source,next_translation,next_normalized_translation,next_type,next_pos)
      WHERE e.id=v.id::uuid AND e.pack_id=${sql(packId)} AND e.source_text=v.previous_source
      RETURNING e.id
    ) SELECT count(*) INTO changed FROM replaced;
    IF changed <> 50 THEN RAISE EXCEPTION 'English unit ${unit.number} entry state mismatch: %', changed; END IF;
  END $$;`);
};

export const up = (pgm) => {
  guarded(pgm);
  units.forEach((unit, index) => updateUnit(pgm, unit, index, false));
};

export const down = (pgm) => {
  guarded(pgm);
  units.forEach((unit, index) => updateUnit(pgm, unit, index, true));
};
