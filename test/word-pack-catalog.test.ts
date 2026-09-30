import assert from 'node:assert/strict';
import test from 'node:test';
import { reviewedPacks } from '../migrations/data/word-pack-expansion.js';
// Keep declarations outside the migrations directory: the runner loads every file there.
const migrationPath = '../migrations/1789488020000_word-pack-catalog-expansion.js';
const { up, down } = (await import(migrationPath)) as {
  up(pgm: { sql(statement: string): void }): void;
  down(pgm: { sql(statement: string): void }): void;
};

test('reviewed catalog has complete, unique senses and contiguous units', () => {
  assert.equal(reviewedPacks.length, 11);
  const packs = new Set<string>();
  const units = new Map<string, number[]>();
  for (const { topic, level, unit, title, words } of reviewedPacks) {
    const key = `${topic[0]}-${level}`;
    assert.ok(!packs.has(`${key}-${unit}`), `duplicate pack ${key}-${unit}`);
    packs.add(`${key}-${unit}`);
    units.set(key, [...(units.get(key) ?? []), unit]);
    assert.ok(topic.every((value: string) => value.trim()));
    assert.ok(title.trim());
    assert.ok(words.length >= 4, `incomplete pack ${key}-${unit}`);
    const senses = new Set<string>();
    for (const [source, translation, partOfSpeech] of words) {
      assert.match(source, /^[a-z]+(?: [a-z]+)*$/u);
      assert.match(translation, /[א-ת]/u);
      assert.ok(['noun', 'adjective'].includes(partOfSpeech));
      const sense = `${source.toLowerCase()}|${translation.normalize('NFC')}`;
      assert.ok(!senses.has(sense), `duplicate sense ${sense}`);
      senses.add(sense);
    }
  }
  assert.deepEqual([...units.keys()].sort(), [
    'animals-beginner',
    'business-intermediate',
    'colors-beginner',
    'current-events-intermediate',
    'everyday-words-intermediate',
    'fruits-and-vegetables-intermediate',
    'household-items-beginner',
    'sports-intermediate',
  ]);
  for (const numbers of units.values()) {
    assert.deepEqual(
      numbers,
      numbers.map((_, index) => index + 1),
    );
  }
});

test('migration only inserts new English to Hebrew IDs and protects installed progress on rollback', () => {
  const statements: string[] = [];
  up({ sql: (statement: string) => statements.push(statement) });
  const catalogSql = statements.join('\n');
  assert.equal((catalogSql.match(/INSERT INTO product_gotit.word_topics/g) ?? []).length, 1);
  assert.equal((catalogSql.match(/INSERT INTO product_gotit.word_tracks/g) ?? []).length, 8);
  assert.equal((catalogSql.match(/INSERT INTO product_gotit.word_packs/g) ?? []).length, 11);
  assert.equal((catalogSql.match(/INSERT INTO product_gotit.word_pack_entries/g) ?? []).length, 11);
  assert.equal((catalogSql.match(/'en','he'/g) ?? []).length, 8);
  assert.doesNotMatch(catalogSql, /\b(?:UPDATE|DELETE)\b/u);
  assert.ok(!catalogSql.includes('he-en'));
  assert.ok(catalogSql.includes("'household-items-beginner-2-en-he'"));

  const rollback: string[] = [];
  down({ sql: (statement: string) => rollback.push(statement) });
  assert.match(rollback[0] ?? '', /user_word_packs/u);
  assert.match(rollback[0] ?? '', /learning_item_pack_entries/u);
  assert.match(rollback[0] ?? '', /RAISE EXCEPTION/u);
});
