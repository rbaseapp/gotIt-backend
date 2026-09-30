import { reviewedPacks } from './data/word-pack-expansion.js';

const uuid = (prefix, sequence) =>
  `${prefix}0000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
const sql = (value) => (value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`);
const insert = (pgm, table, columns, rows) => {
  pgm.sql(
    `INSERT INTO product_gotit.${table} (${columns.join(',')}) VALUES\n${rows
      .map((row) => `  (${row.map(sql).join(',')})`)
      .join(',\n')};`,
  );
};

const newTopics = [
  ...new Map(
    reviewedPacks
      .filter(({ topic }) => ['colors', 'animals', 'household-items'].includes(topic[0]))
      .map(({ topic }) => [topic[0], topic]),
  ).values(),
];
const tracks = [
  ...new Map(
    reviewedPacks.map(({ topic, level }) => [`${topic[0]}-${level}`, [topic[0], level]]),
  ).values(),
];

export const up = (pgm) => {
  insert(
    pgm,
    'word_topics',
    ['id', 'slug', 'title', 'description', 'sort_order'],
    newTopics.map(([slug, title, description], index) => [
      uuid(9, index + 1),
      slug,
      title,
      description,
      (index + 7) * 10,
    ]),
  );

  for (const [index, [topicSlug, level]] of tracks.entries()) {
    const topic = reviewedPacks.find(({ topic }) => topic[0] === topicSlug).topic;
    const topicId = newTopics.findIndex(([slug]) => slug === topicSlug);
    const selectedTopicId =
      topicId >= 0
        ? uuid(9, topicId + 1)
        : {
            business: uuid(1, 1),
            sports: uuid(5, 1),
            'fruits-and-vegetables': uuid(5, 2),
            'everyday-words': uuid(5, 3),
            'current-events': uuid(5, 5),
          }[topicSlug];
    if (!selectedTopicId) throw new Error(`Unknown catalog topic: ${topicSlug}`);
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
      [
        [
          uuid('a', index + 1),
          selectedTopicId,
          `${topicSlug}-${level}-en-he`,
          `${topic[1]} — ${level === 'beginner' ? 'מתחילים' : 'בינוניים'}`,
          topic[2],
          level,
          level === 'beginner' ? 'A1' : 'B1',
          level === 'beginner' ? 'A2' : 'B2',
          'en',
          'he',
          level === 'beginner' ? 10 : 20,
        ],
      ],
    );
  }

  let entrySequence = 0;
  reviewedPacks.forEach(({ topic, level, unit, title, words }, packIndex) => {
    const trackIndex = tracks.findIndex(
      ([slug, trackLevel]) => slug === topic[0] && trackLevel === level,
    );
    const packId = uuid('b', packIndex + 1);
    insert(
      pgm,
      'word_packs',
      ['id', 'track_id', 'slug', 'module_number', 'title', 'description', 'version', 'sort_order'],
      [
        [
          packId,
          uuid('a', trackIndex + 1),
          `${topic[0]}-${level}-${unit}-en-he`,
          unit,
          title,
          topic[2],
          1,
          unit * 10,
        ],
      ],
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
      words.map(([source, translation, partOfSpeech], index) => {
        entrySequence += 1;
        return [
          uuid('c', entrySequence),
          packId,
          source,
          source.toLowerCase(),
          translation,
          translation,
          'word',
          partOfSpeech,
          null,
          (index + 1) * 10,
        ];
      }),
    );
  });
};

export const down = (pgm) => {
  const packIds = reviewedPacks.map((_, index) => sql(uuid('b', index + 1))).join(',');
  const trackIds = tracks.map((_, index) => sql(uuid('a', index + 1))).join(',');
  const topicIds = newTopics.map((_, index) => sql(uuid(9, index + 1))).join(',');
  // An installed pack may contain user progress. Never silently remove it.
  pgm.sql(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM product_gotit.user_word_packs WHERE pack_id IN (${packIds}))
       OR EXISTS (SELECT 1 FROM product_gotit.learning_item_pack_entries WHERE pack_id IN (${packIds}))
    THEN RAISE EXCEPTION 'Cannot roll back installed word packs with user progress';
    END IF;
  END $$;`);
  pgm.sql(`DELETE FROM product_gotit.word_packs WHERE id IN (${packIds});`);
  pgm.sql(`DELETE FROM product_gotit.word_tracks WHERE id IN (${trackIds});`);
  pgm.sql(`DELETE FROM product_gotit.word_topics WHERE id IN (${topicIds});`);
};
