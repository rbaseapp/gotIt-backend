import assert from 'node:assert/strict';
import test from 'node:test';
import blueprint from '../migrations/data/english-communication-blueprint.json' with { type: 'json' };
import catalog from '../migrations/data/english-communication-en-he.json' with { type: 'json' };
import senseCorrections from '../migrations/data/english-communication-sense-corrections.json' with { type: 'json' };
import uniqueCatalog from '../migrations/data/english-unique-3000-en-he.json' with { type: 'json' };
import { readFileSync } from 'node:fs';
import { sessionSchema } from '../src/modules/practice/practice.validation.js';
import {
  addSchema,
  catalogQuerySchema,
  knownSchema,
  removalSchema,
} from '../src/modules/word-packs/word-packs.validation.js';

const id = '30000000-0000-4000-8000-000000000001';

test('curriculum order is restricted to unit-owned smart practice', () => {
  assert.equal(
    sessionSchema.safeParse({
      sessionType: 'smart_review',
      scope: { type: 'pack', id },
      curriculumOrder: true,
    }).success,
    true,
  );
  for (const input of [
    { sessionType: 'smart_review', curriculumOrder: true },
    { sessionType: 'recall', scope: { type: 'pack', id }, curriculumOrder: true },
    { sessionType: 'smart_review', scope: { type: 'track', id }, curriculumOrder: true },
  ])
    assert.equal(sessionSchema.safeParse(input).success, false);
});

test('catalog accepts explicit BCP-47 languages and preserves the no-query contract', () => {
  assert.deepEqual(catalogQuerySchema.parse({}), {});
  assert.deepEqual(
    catalogQuerySchema.parse({ sourceLanguageCode: 'en-us', translationLanguageCode: 'he-il' }),
    {
      sourceLanguageCode: 'en-US',
      translationLanguageCode: 'he-IL',
    },
  );
  assert.equal(catalogQuerySchema.safeParse({ sourceLanguageCode: 'bad language' }).success, false);
  assert.equal(catalogQuerySchema.safeParse({ sourceLanguageCode: ['en', 'fr'] }).success, false);
  assert.equal(catalogQuerySchema.safeParse({ applicationUserId: id }).success, false);
});

test('replacement English catalog matches the supplied 60 units without repeated words', () => {
  const source = readFileSync(
    new URL('../migrations/data/english-unique-3000-source.txt', import.meta.url),
    'utf8',
  );
  const supplied = [...source.matchAll(/^Unit (\d+) — (.+)\r?\n([^\r\n]+)/gm)];
  assert.equal(supplied.length, 60);
  assert.equal(uniqueCatalog.length, 60);
  const all: string[] = [];
  for (const [index, unit] of uniqueCatalog.entries()) {
    const [, number, name, words] = supplied[index]!;
    assert.equal(unit.number, Number(number));
    assert.equal(unit.name, name);
    assert.equal(unit.entries.length, 50);
    assert.deepEqual(
      unit.entries.map(({ en }) => en),
      words!.split(',').map((word) => word.trim()),
    );
    assert.ok(unit.entries.every(({ he }) => /[\u05d0-\u05ea]/u.test(he)));
    all.push(...unit.entries.map(({ en }) => en.toLocaleLowerCase('en')));
  }
  assert.equal(all.length, 3000);
  assert.equal(new Set(all).size, 3000);
  assert.equal(
    uniqueCatalog[4]!.entries.filter(({ en }) => en.toLocaleLowerCase('en') === 'may').length,
    1,
  );
  assert.equal(
    uniqueCatalog[16]!.entries.some(({ en }) => en.toLocaleLowerCase('en') === 'may'),
    false,
  );
});

test('English catalog keeps the supplied 60 named themes with 50 translated entries each', () => {
  assert.equal(catalog.length, 60);
  assert.equal(blueprint.length, 60);
  for (const [index, unit] of catalog.entries()) {
    assert.equal(unit.number, index + 1);
    assert.equal(unit.moduleNumber, (index % 20) + 1);
    assert.equal(unit.name, blueprint[index]!.name.replace(/^— /, ''));
    assert.equal(unit.entries.length, 50);
    assert.equal(new Set(unit.entries.map(({ en }) => en.toLowerCase())).size, 50);
    assert.ok(unit.entries.every(({ en, he }) => en.trim() && he.trim()));
    const supplied = new Set(
      blueprint[index]!.proposedEntries.map(
        (word) =>
          ({
            checkin: 'check-in',
            checkout: 'check-out',
            trafficjam: 'traffic jam',
            middleeast: 'Middle East',
          })[word.toLowerCase() as 'checkin' | 'checkout' | 'trafficjam' | 'middleeast'] ?? word,
      ).map((word) => word.toLowerCase()),
    );
    assert.ok(
      [...supplied].every((word) => unit.entries.some(({ en }) => en.toLowerCase() === word)),
    );
  }
  assert.deepEqual(
    catalog[4]!.entries.slice(22, 29).map(({ en }) => en),
    ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  );
  assert.ok(catalog[5]!.entries.some(({ en }) => en === 'refrigerator'));
  assert.ok(
    !catalog.slice(0, 20).some((unit) => unit.entries.some(({ en }) => en === 'satellite')),
  );
});

test('contextual Hebrew senses cover ambiguous everyday and advanced English words', () => {
  assert.equal(
    new Set(senseCorrections.map(({ unit, en }) => `${unit}/${en}`)).size,
    senseCorrections.length,
  );
  for (const { unit, en, he } of senseCorrections) {
    const original = catalog[unit - 1]?.entries.find((entry) => entry.en === en);
    assert.ok(original, `missing source entry ${unit}/${en}`);
    assert.notEqual(original.he, he, `unchanged correction ${unit}/${en}`);
    assert.ok(he.trim(), `empty correction ${unit}/${en}`);
  }
  const sense = (unit: number, en: string) =>
    senseCorrections.find((item) => item.unit === unit && item.en === en)?.he ??
    catalog[unit - 1]!.entries.find((item) => item.en === en)!.he;
  assert.equal(sense(5, 'May'), 'מאי');
  assert.equal(sense(17, 'may'), 'ייתכן ש־');
  assert.equal(sense(48, 'may'), 'ייתכן ש־');
  assert.equal(sense(9, 'park'), 'פארק');
  assert.equal(sense(13, 'body'), 'גוף');
  assert.equal(sense(28, 'tire'), 'צמיג');
  assert.equal(sense(50, 'fine'), 'קנס');
});

test('pack, track, and topic are valid practice scopes', () => {
  for (const type of ['pack', 'track', 'topic'] as const)
    assert.equal(
      sessionSchema.safeParse({ sessionType: 'smart_review', scope: { type, id } }).success,
      true,
    );
  assert.equal(
    sessionSchema.safeParse({
      sessionType: 'smart_review',
      count: 100,
      scope: { type: 'pack', id },
    }).success,
    true,
  );
});

test('practice scope cannot be combined with explicit items or reading content', () => {
  assert.equal(
    sessionSchema.safeParse({
      sessionType: 'recall',
      learningItemIds: [id],
      scope: { type: 'pack', id },
    }).success,
    false,
  );
  assert.equal(
    sessionSchema.safeParse({
      sessionType: 'article_quiz',
      readingId: id,
      scope: { type: 'pack', id },
    }).success,
    false,
  );
});

test('word pack removal defaults to safe archival and supports keeping words', () => {
  assert.equal(removalSchema.parse({}).mode, 'archive_exclusive');
  assert.equal(removalSchema.parse({ mode: 'keep_words' }).mode, 'keep_words');
});

test('word pack selection accepts empty to remove the last selected word', () => {
  assert.equal(addSchema.safeParse({ entryIds: [id] }).success, true);
  assert.equal(addSchema.safeParse({ entryIds: [] }).success, true);
  assert.equal(addSchema.safeParse({ entryIds: [id, id] }).success, false);
});

test('known selections require explicit state and distinct pack entries', () => {
  assert.equal(knownSchema.safeParse({ entryIds: [id], known: true }).success, true);
  assert.equal(knownSchema.safeParse({ entryIds: [id], known: false }).success, true);
  assert.equal(knownSchema.safeParse({ entryIds: [], known: true }).success, false);
  assert.equal(knownSchema.safeParse({ entryIds: [id, id], known: true }).success, false);
  assert.equal(knownSchema.safeParse({ entryIds: [id] }).success, false);
});
