import corrections from './data/english-learning-corrections.json' with { type: 'json' };

const uuid = (family, number) =>
  `d${family}000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const sql = (value) => `'${String(value).replaceAll("'", "''")}'`;
const topicId = uuid(1, 1);

const updateEntries = (pgm, reverse) => {
  const rows = corrections
    .map(
      ({ number, before, after }) =>
        `(${sql(uuid(4, number))}, ${sql(reverse ? after : before)}, ${sql(reverse ? before : after)})`,
    )
    .join(',\n');
  pgm.sql(`DO $$
    DECLARE changed integer;
    BEGIN
      WITH corrected AS (
        UPDATE product_gotit.word_pack_entries entry
        SET translation_text = fix.replacement,
            normalized_translation_text = fix.replacement
        FROM (VALUES ${rows}) AS fix(id, previous, replacement)
        WHERE entry.id = fix.id::uuid AND entry.translation_text = fix.previous
        RETURNING entry.id
      ) SELECT count(*) INTO changed FROM corrected;
      IF changed <> ${corrections.length} THEN
        RAISE EXCEPTION 'English learning translation state mismatch: % of ${corrections.length}', changed;
      END IF;
    END $$;`);
};

export const up = (pgm) => {
  pgm.sql(`DO $$
    DECLARE changed integer;
    BEGIN
      UPDATE product_gotit.word_topics
      SET slug = 'english-learning-path-en-he',
          title = 'מסלול לימוד אנגלית',
          description = 'לימוד אנגלית מעברית בשלוש רמות מדורגות וביחידות של 50 מילים וביטויים'
      WHERE id = ${sql(topicId)} AND slug = 'daily-english';
      GET DIAGNOSTICS changed = ROW_COUNT;
      IF changed <> 1 THEN RAISE EXCEPTION 'Initial English catalog migration is missing'; END IF;
    END $$;`);
  updateEntries(pgm, false);
};

export const down = (pgm) => {
  const ids = Array.from({ length: 60 }, (_, index) => sql(uuid(3, index + 1))).join(',');
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM product_gotit.user_word_packs WHERE pack_id IN (${ids}))
       OR EXISTS (SELECT 1 FROM product_gotit.learning_item_pack_entries WHERE pack_id IN (${ids}))
    THEN RAISE EXCEPTION 'Cannot roll back English learning path with user progress';
    END IF;
  END $$;`);
  updateEntries(pgm, true);
  pgm.sql(`UPDATE product_gotit.word_topics
    SET slug = 'daily-english',
        title = 'אנגלית יום־יומית',
        description = 'מסלול מדורג של מילים וביטויים שימושיים'
    WHERE id = ${sql(topicId)} AND slug = 'english-learning-path-en-he';`);
};
