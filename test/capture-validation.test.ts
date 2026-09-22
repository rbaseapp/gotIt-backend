import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  parseInput,
  previewSchema,
  saveSchema,
  textSchema,
} from '../src/modules/capture/capture.validation.js';
import { captureIntentHash, SelectionProofs } from '../src/modules/enrichment/selection-proof.js';
import type { ProviderFacts } from '../src/modules/enrichment/enrichment.types.js';

const body = () => ({
  item: { sourceText: ' charge ', sourceLanguageCode: 'EN', translationLanguageCode: 'HE' },
  translation: { text: ' fee ', variants: ['cost', 'price'] },
  context: { selectedText: 'charge' },
  senseDecision: { mode: 'auto' },
});
test('capture normalization preserves display case and multilingual text; intent ignores key order/defaults', () => {
  const input = parseInput(saveSchema, body());
  assert.equal(input.item.sourceText, 'charge');
  assert.equal(input.item.sourceLanguageCode, 'en');
  const equivalent = parseInput(saveSchema, {
    ...body(),
    clientEventId: randomUUID(),
    item: { ...body().item, itemType: 'other', partOfSpeech: null },
    translation: { text: 'fee', variants: ['price', 'cost'] },
    context: { selectedText: 'charge', sentenceText: null },
  });
  assert.equal(captureIntentHash(input, null), captureIntentHash(equivalent, null));
  assert.equal(parseInput(textSchema(5), 'Ａ  א'), 'A א');
  assert.equal(parseInput(textSchema(2), '😀😀'), '😀😀');
  assert.throws(() => parseInput(textSchema(2), '😀😀😀'));
});
test('strict capture input rejects forged provenance, ambiguous duplicates, unsafe URLs and invalid time/language', () => {
  for (const input of [
    { ...body(), applicationUserId: randomUUID() },
    { ...body(), item: { ...body().item, sourceLanguageCode: 'not_a_language' } },
    {
      ...body(),
      item: { ...body().item, sourceLanguageCode: 'he', translationLanguageCode: 'he-IL' },
    },
    { ...body(), translation: { text: 'fee', variants: [' ＦＥＥ '] } },
    { ...body(), translation: { ...body().translation, providerName: 'anthropic' } },
    { ...body(), senseDecision: { mode: 'auto', learningItemId: randomUUID() } },
    {
      ...body(),
      context: { selectedText: 'charge', pageUrl: 'https://user:password@example.test' },
    },
    { ...body(), context: { selectedText: 'charge', pageUrl: 'file:///private' } },
    { ...body(), context: { selectedText: 'charge', sentenceText: 'secret\u0000data' } },
    { ...body(), context: { selectedText: 'charge', paragraphText: 'a'.repeat(12001) } },
    { ...body(), context: { selectedText: 'charge', capturedAt: '1969-12-31T23:59:59Z' } },
    {
      ...body(),
      context: { selectedText: 'charge', capturedAt: new Date(Date.now() + 600000).toISOString() },
    },
  ])
    assert.throws(() => parseInput(saveSchema, input));
  const preview = parseInput(previewSchema, {
    selectedText: 'charge',
    context: { sentenceText: '  a\r\nb  ', pageUrl: 'HTTPS://EXAMPLE.TEST:443/a' },
  });
  assert.equal(preview.context?.sentenceText, 'a\nb');
  assert.equal(preview.context?.pageUrl, 'https://example.test/a');
  assert.equal(preview.context?.paragraphText, null);
});
test('selection proof binds scope, accepted fields and context; expiry/key rotation only permit receipt comparison', () => {
  const scope = { applicationId: randomUUID(), applicationUserId: randomUUID() };
  const input = parseInput(saveSchema, body());
  const facts: ProviderFacts = {
    providerName: 'anthropic',
    providerType: 'ai',
    providerModel: 'configured-model',
    runId: randomUUID(),
    candidate: {
      text: 'fee',
      variants: ['price', 'cost'],
      partOfSpeech: null,
      explanation: null,
      phoneticText: null,
      phoneticScheme: null,
      examples: [],
      contextUsed: false,
    },
  };
  let now = 1000;
  const proofs = new SelectionProofs('s'.repeat(32), () => now);
  const token = proofs.issue(scope, input.item, input.context.sentenceText, facts);
  const claim = proofs.decode(token);
  assert.deepEqual(proofs.verify(token, claim, scope, input), facts);
  assert.throws(() =>
    proofs.verify(token, claim, { ...scope, applicationUserId: randomUUID() }, input),
  );
  assert.throws(() =>
    proofs.verify(token, claim, scope, {
      ...input,
      context: { ...input.context, sentenceText: 'different' },
    }),
  );
  const altered = `${token.split('.')[0]}.${'x'.repeat(43)}`;
  assert.throws(() => proofs.verify(altered, proofs.decode(altered), scope, input));
  now = 601001;
  assert.throws(() => proofs.verify(token, claim, scope, input), /expired/u);
  const rotated = new SelectionProofs('r'.repeat(32));
  assert.equal(
    captureIntentHash(input, rotated.decode(token).facts),
    captureIntentHash(input, facts),
  );
  assert.throws(() => rotated.verify(token, rotated.decode(token), scope, input));
});
