import tiers from './data/daily-english-en-he.json' with { type: 'json' };

const uuid = (family, number) =>
  `d${family}000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const sql = (value) =>
  value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
const insert = (pgm, table, columns, rows) => {
  pgm.sql(
    `INSERT INTO product_gotit.${table} (${columns.join(',')}) VALUES\n${rows
      .map((row) => `  (${row.map(sql).join(',')})`)
      .join(',\n')};`,
  );
};

const tracks = [
  {
    slug: 'basic',
    title: 'אנגלית בסיסית',
    description: '1,000 מילים וביטויים שימושיים להתחלת שיחה יומיומית',
    level: 'beginner',
    from: 'A1',
    to: 'A2',
  },
  {
    slug: 'good',
    title: 'אנגלית טובה',
    description: '1,000 מילים וביטויים נוספים להרחבת שיחה והבנה',
    level: 'intermediate',
    from: 'A2',
    to: 'B2',
  },
  {
    slug: 'advanced',
    title: 'אנגלית מתקדמת',
    description: '1,000 מילים וביטויים נוספים לביטוי מדויק וגמיש',
    level: 'advanced',
    from: 'B1',
    to: 'C1',
  },
];

export const up = (pgm) => {
  if (
    tiers.length !== 3 ||
    tiers.some((tier) => tier.length !== 1000) ||
    tiers.some((tier) => tier.some((entry) => !entry.en || !entry.he))
  ) {
    throw new Error('Daily English catalog must have three complete 1,000-entry tracks');
  }

  insert(
    pgm,
    'word_topics',
    ['id', 'slug', 'title', 'description', 'sort_order'],
    [[uuid(1, 1), 'daily-english', 'אנגלית יום־יומית', 'מסלול מדורג של מילים וביטויים שימושיים', 5]],
  );
  insert(
    pgm,
    'word_tracks',
    [
      'id',
      'topic_id',
      'slug',
      'title',
      'description',
      'level_code',
      'cefr_from',
      'cefr_to',
      'source_language_code',
      'translation_language_code',
      'sort_order',
    ],
    tracks.map((track, index) => [
      uuid(2, index + 1),
      uuid(1, 1),
      `daily-english-${track.slug}-en-he`,
      track.title,
      track.description,
      track.level,
      track.from,
      track.to,
      'en',
      'he',
      (index + 1) * 10,
    ]),
  );

  for (let tierIndex = 0; tierIndex < tracks.length; tierIndex += 1) {
    const track = tracks[tierIndex];
    for (let unit = 1; unit <= 20; unit += 1) {
      const packNumber = tierIndex * 20 + unit;
      const packId = uuid(3, packNumber);
      insert(
        pgm,
        'word_packs',
        ['id', 'track_id', 'slug', 'module_number', 'title', 'description', 'version', 'sort_order'],
        [[
          packId,
          uuid(2, tierIndex + 1),
          `daily-english-${track.slug}-${String(unit).padStart(2, '0')}-en-he`,
          unit,
          `יחידה ${unit}: ${track.title}`,
          `פריטים ${((unit - 1) * 50 + 1).toLocaleString('en-US')}–${(unit * 50).toLocaleString('en-US')} במסלול`,
          1,
          unit * 10,
        ]],
      );
      insert(
        pgm,
        'word_pack_entries',
        [
          'id',
          'pack_id',
          'source_text',
          'normalized_source_text',
          'translation_text',
          'normalized_translation_text',
          'item_type',
          'part_of_speech',
          'example_text',
          'sort_order',
        ],
        tiers[tierIndex].slice((unit - 1) * 50, unit * 50).map((entry, index) => [
          uuid(4, tierIndex * 1000 + (unit - 1) * 50 + index + 1),
          packId,
          entry.en,
          entry.en.toLowerCase(),
          entry.he,
          entry.he.normalize('NFC'),
          entry.type,
          entry.pos,
          null,
          (index + 1) * 10,
        ]),
      );
    }
  }
};

export const down = (pgm) => {
  const packIds = Array.from({ length: 60 }, (_, index) => sql(uuid(3, index + 1))).join(',');
  const trackIds = tracks.map((_, index) => sql(uuid(2, index + 1))).join(',');
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM product_gotit.user_word_packs WHERE pack_id IN (${packIds}))
       OR EXISTS (SELECT 1 FROM product_gotit.learning_item_pack_entries WHERE pack_id IN (${packIds}))
    THEN RAISE EXCEPTION 'Cannot roll back installed daily English packs with user progress';
    END IF;
  END $$;`);
  pgm.sql(`DELETE FROM product_gotit.word_packs WHERE id IN (${packIds});`);
  pgm.sql(`DELETE FROM product_gotit.word_tracks WHERE id IN (${trackIds});`);
  pgm.sql(`DELETE FROM product_gotit.word_topics WHERE id=${sql(uuid(1, 1))};`);
};
