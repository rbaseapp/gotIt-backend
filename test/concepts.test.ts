import assert from 'node:assert/strict';
import test from 'node:test';
import { conceptDocumentSchema } from '../src/modules/concepts/concepts.schema.js';

const doc = {
  key: 'apple-fruit',
  title: 'Apple',
  definition: 'An apple fruit',
  visualDescription: 'One red apple',
  expressions: [
    { languageCode: 'en', text: 'apple' },
    { languageCode: 'he', text: 'תפוח' },
  ],
};
test('concept expressions require distinct languages, canonical tags and normalized unique forms', () => {
  assert.equal(conceptDocumentSchema.parse(doc).status, 'active');
  assert.equal(conceptDocumentSchema.parse(doc).stockSearchQuery, '');
  assert.equal(
    conceptDocumentSchema.safeParse({ ...doc, stockSearchQuery: 'תפוח' }).success,
    false,
  );
  assert.equal(
    conceptDocumentSchema.parse({
      ...doc,
      expressions: [{ languageCode: 'EN-us', text: 'apple' }, doc.expressions[1]],
    }).expressions[0]!.languageCode,
    'en-US',
  );
  for (const expressions of [
    [
      { languageCode: 'en', text: 'apple' },
      { languageCode: 'en', text: 'fruit' },
    ],
    [...doc.expressions, { languageCode: 'en', text: ' APPLE ' }],
    [{ languageCode: 'invalid_tag', text: 'apple' }, doc.expressions[1]],
  ])
    assert.equal(conceptDocumentSchema.safeParse({ ...doc, expressions }).success, false);
  assert.equal(
    conceptDocumentSchema.safeParse({ ...doc, applicationId: 'injected' }).success,
    false,
  );
});
