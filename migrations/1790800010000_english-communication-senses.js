import units from './data/english-communication-en-he.json' with { type: 'json' };
import corrections from './data/english-communication-sense-corrections.json' with { type: 'json' };

const quote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const uuid = (family, number) =>
  `d${family}000000-0000-4000-8000-${String(number).padStart(12, '0')}`;

const seen = new Set();
const changes = corrections.map(({ unit, en, he }) => {
  const entryIndex = units[unit - 1]?.entries.findIndex((entry) => entry.en === en);
  if (entryIndex === undefined || entryIndex < 0 || !he?.trim())
    throw new Error(`Invalid English sense correction: ${unit}/${en}`);
  const key = `${unit}/${en}`;
  if (seen.has(key)) throw new Error(`Repeated English sense correction: ${key}`);
  seen.add(key);
  const before = units[unit - 1].entries[entryIndex].he;
  if (before === he) throw new Error(`Unchanged English sense correction: ${key}`);
  return { unit, en, id: uuid(4, (unit - 1) * 50 + entryIndex + 1), before, after: he };
});

const correctedUnits = [...new Set(changes.map(({ unit }) => unit))];
const unitIds = correctedUnits.map((unit) => quote(uuid(3, unit))).join(',');

const migrate = (pgm, reverse) => {
  const rows = changes
    .map(({ id, en, before, after }) => {
      const from = reverse ? after : before;
      const to = reverse ? before : after;
      return `(${quote(id)},${quote(en)},${quote(from)},${quote(to)},${quote(to.normalize('NFC'))})`;
    })
    .join(',\n');
  const oldVersion = reverse ? 3 : 2;
  const newVersion = reverse ? 2 : 3;
  pgm.sql(`DO $$ DECLARE changed integer; BEGIN
    WITH revised AS (
      UPDATE product_gotit.word_pack_entries e
      SET translation_text=v.next_translation,
          normalized_translation_text=v.next_normalized_translation,
          updated_at=now()
      FROM (VALUES ${rows}) AS v(id,source,previous_translation,next_translation,next_normalized_translation)
      WHERE e.id=v.id::uuid AND e.source_text=v.source
        AND e.translation_text=v.previous_translation
      RETURNING e.id
    ) SELECT count(*) INTO changed FROM revised;
    IF changed <> ${changes.length} THEN
      RAISE EXCEPTION 'English sense correction state mismatch: %', changed;
    END IF;
    UPDATE product_gotit.word_packs SET version=${newVersion},updated_at=now()
    WHERE id IN (${unitIds}) AND version=${oldVersion};
    GET DIAGNOSTICS changed = ROW_COUNT;
    IF changed <> ${correctedUnits.length} THEN
      RAISE EXCEPTION 'English sense correction pack version mismatch: %', changed;
    END IF;
  END $$;`);
};

export const up = (pgm) => migrate(pgm, false);
export const down = (pgm) => migrate(pgm, true);
