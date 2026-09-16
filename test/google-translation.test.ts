import assert from 'node:assert/strict';
import test from 'node:test';
import { GoogleCloudTranslationProvider } from '../src/modules/enrichment/providers/google-cloud.js';
import { EnrichmentRegistry } from '../src/modules/enrichment/enrichment.registry.js';
test('Google v2 uses a header credential, plain lexical text and explicit language mapping without claiming context or models', async () => {
  const provider = new GoogleCloudTranslationProvider(
    'synthetic-key',
    { 'zh-Hant': 'zh-TW' },
    async (url, init) => {
      assert.ok(!String(url).includes('synthetic-key'));
      assert.equal(new Headers(init?.headers).get('X-Goog-Api-Key'), 'synthetic-key');
      assert.deepEqual(JSON.parse(init?.body as string), {
        q: ['hello'],
        target: 'zh-TW',
        format: 'text',
      });
      return Response.json({
        data: {
          translations: [
            { translatedText: 'Hello &amp; &#39;world&#39;', detectedSourceLanguage: 'en' },
          ],
        },
      });
    },
  );
  const registry = new EnrichmentRegistry(
    [provider],
    [{ id: 'google', providerId: provider.id, model: null, timeoutMs: 1000 }],
    { auto: { profiles: ['google'], timeoutMs: 1000 } },
  );
  const result = await registry.enrich(
    'auto',
    {
      sourceText: 'hello',
      sourceLanguageCode: null,
      translationLanguageCode: 'zh-Hant',
      sentenceText: 'untrusted context',
    },
    async () => {},
  );
  assert.equal(result.status, 'succeeded');
  if (result.status === 'succeeded') {
    assert.equal(result.output.sourceLanguageCode, 'en');
    assert.equal(result.output.candidates[0]?.text, "Hello & 'world'");
    assert.equal(result.output.candidates[0]?.contextUsed, false);
    assert.equal(result.profile.model, null);
  }
});
