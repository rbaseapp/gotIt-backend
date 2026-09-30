import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

type Entry = {
  en: string;
  he: string;
  type: 'word' | 'phrase';
  pos: string | null;
  cocaRank: number | null;
};

const tiers = JSON.parse(
  readFileSync(new URL('../migrations/data/daily-english-en-he.json', import.meta.url), 'utf8'),
) as Entry[][];

const { up, down } = (await import('../migrations/1790800006000_daily-english-catalog.js')) as {
  up(pgm: { sql(statement: string): void }): void;
  down(pgm: { sql(statement: string): void }): void;
};

test('daily English catalog has 3 disjoint 1,000-entry tracks in 50-entry units', () => {
  assert.equal(tiers.length, 3);
  const seen = new Set<string>();
  tiers.forEach((tier, tierIndex) => {
    assert.equal(tier.length, 1000, `track ${tierIndex + 1}`);
    for (let start = 0; start < tier.length; start += 50) {
      assert.equal(tier.slice(start, start + 50).length, 50);
    }
    for (const entry of tier) {
      assert.equal(entry.en, entry.en.trim());
      assert.equal(entry.he, entry.he.trim());
      assert.match(entry.en, /^[A-Za-z](?:[A-Za-z' ?-]*[A-Za-z?])?$/u);
      assert.match(entry.he, /[א-ת]/u);
      assert.ok(!/[\r\n<>\[\]]/u.test(entry.he));
      assert.ok(['word', 'phrase'].includes(entry.type));
      const normalized = entry.en.toLowerCase();
      assert.ok(!seen.has(normalized), `duplicate ${entry.en}`);
      seen.add(normalized);
    }
  });
  assert.equal(seen.size, 3000);
  assert.equal(tiers[0][0].en.toLowerCase(), 'good morning');
  assert.ok(tiers[0].slice(0, 50).some(({ en }) => en.toLowerCase() === 'i'));
  assert.ok(tiers[0].slice(0, 50).some(({ en }) => en.toLowerCase() === 'thank you'));
  assert.ok(tiers[1].some(({ en }) => en === 'look forward to'));
  assert.ok(tiers[2].some(({ en }) => en === 'take into account'));
});

test('catalog migration only inserts its 60 packs and refuses rollback with user progress', () => {
  const statements: string[] = [];
  up({ sql: (statement: string) => statements.push(statement) });
  const joined = statements.join('\n');
  assert.equal((joined.match(/INSERT INTO product_gotit.word_topics/g) ?? []).length, 1);
  assert.equal((joined.match(/INSERT INTO product_gotit.word_tracks/g) ?? []).length, 1);
  assert.equal((joined.match(/INSERT INTO product_gotit.word_packs/g) ?? []).length, 60);
  assert.equal((joined.match(/INSERT INTO product_gotit.word_pack_entries/g) ?? []).length, 60);
  assert.ok(joined.includes("'daily-english-basic-01-en-he'"));
  assert.ok(joined.includes("'daily-english-advanced-20-en-he'"));
  assert.doesNotMatch(joined, /\b(?:UPDATE|DELETE)\b/u);

  const rollback: string[] = [];
  down({ sql: (statement: string) => rollback.push(statement) });
  assert.match(rollback[0] ?? '', /user_word_packs/u);
  assert.match(rollback[0] ?? '', /learning_item_pack_entries/u);
  assert.match(rollback[0] ?? '', /RAISE EXCEPTION/u);
});
