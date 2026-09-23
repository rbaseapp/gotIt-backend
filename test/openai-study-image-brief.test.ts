import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAiStudyImageBriefResolver } from '../src/modules/practice/openai-study-image-brief.resolver.js';
import { FallbackStudyImageProvider } from '../src/modules/practice/study-image.provider.js';

const input = {
  sourceText: 'wear',
  translationText: 'בלאי',
  sourceLanguageCode: 'en',
  translationLanguageCode: 'he',
  context: 'Manganese improves strength, workability, and resistance to wear in stainless steel.',
};

const brief = {
  senseKey: 'wear.damage_from_use',
  subject: 'physical wear from repeated use',
  visualDescription: 'one isolated visibly worn shoe sole with clear abrasion',
  searchQueries: ['worn shoe sole isolated', 'wear and tear abrasion isolated'],
  includeTags: ['worn', 'abrasion', 'shoe sole'],
  excludeTags: ['fashion', 'clothing', 'model', 'manganese', 'steel'],
};

test('brief resolver uses context only to resolve a reusable visual sense', async () => {
  let requestBody: Record<string, any> = {};
  const resolver = new OpenAiStudyImageBriefResolver('server-secret', 'gpt-5.4-nano', (async (
    _url: string | URL | Request,
    init?: RequestInit,
  ) => {
    requestBody = JSON.parse(String(init?.body));
    return Response.json({
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(brief) }] }],
    });
  }) as typeof fetch);

  const resolved = await resolver.resolve(input);

  assert.deepEqual(resolved, brief);
  assert.match(requestBody.instructions, /Use translation and context only to disambiguate/u);
  assert.match(requestBody.instructions, /discard the sentence topic/u);
  assert.match(requestBody.input[0].content, /Manganese/u);
  assert.equal(requestBody.text.format.strict, true);
});

test('fallback chain passes the resolved sense to every image source without changing it', async () => {
  const received: unknown[] = [];
  const resolver = { id: 'test-resolver', resolve: async () => brief };
  const emptyProvider = {
    id: 'empty',
    generate: async (value: unknown) => {
      received.push(value);
      return null;
    },
  };
  const finalProvider = {
    id: 'final',
    generate: async (value: unknown) => {
      received.push(value);
      return {
        data: Buffer.from('image'),
        contentType: 'image/webp' as const,
        kind: 'generated' as const,
        provider: 'test',
        sourceUrl: null,
        creator: null,
      };
    },
  };

  await new FallbackStudyImageProvider([emptyProvider, finalProvider], resolver).generate(input);

  assert.equal(received.length, 2);
  assert.deepEqual((received[0] as { visual: unknown }).visual, brief);
  assert.deepEqual((received[1] as { visual: unknown }).visual, brief);
});
