import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionSchema } from '../src/modules/practice/practice.validation.js';
import { addSchema, removalSchema } from '../src/modules/word-packs/word-packs.validation.js';

const id = '30000000-0000-4000-8000-000000000001';

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

test('word pack additions require a unique, non-empty entry selection', () => {
  assert.equal(addSchema.safeParse({ entryIds: [id] }).success, true);
  assert.equal(addSchema.safeParse({ entryIds: [] }).success, false);
  assert.equal(addSchema.safeParse({ entryIds: [id, id] }).success, false);
});
