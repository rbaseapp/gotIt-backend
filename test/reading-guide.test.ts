import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OpenAiReadingGuideProvider,
  readingGuideRequest,
} from '../src/modules/library/reading-guide.js';
const id = '11111111-1111-4111-8111-111111111111';
const scope = { applicationId: id, applicationUserId: id };
const items = [
  {
    id,
    sourceText: 'ice cream',
    sourceLanguage: 'en',
    nativeLanguage: 'he',
    revision: 1,
    phoneticText: null,
    phoneticScheme: null,
  },
];
const response = (guides: unknown, status = 'completed') =>
  new Response(
    JSON.stringify({
      status,
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({ guides }) }] }],
    }),
    { headers: { 'content-type': 'application/json' } },
  );
test('reading guide asks for source pronunciation in the native alphabet with bounded private input', async () => {
  let quota = 0;
  const provider = new OpenAiReadingGuideProvider(
    'test-key',
    'test-model',
    {
      consume: async () => {
        quota++;
      },
    },
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.store, false);
      assert.match(body.instructions, /never its translation/);
      assert.deepEqual(JSON.parse(body.input), [
        { id, sourceText: 'ice cream', sourceLanguage: 'en', nativeLanguage: 'he' },
      ]);
      return response([{ id, text: 'אַייס קְרִים' }]);
    },
  );
  assert.deepEqual(await provider.generate(items, scope), [{ id, text: 'אַייס קְרִים' }]);
  assert.equal(quota, 1);
});
for (const [name, guides] of [
  ['foreign id', [{ id: '22222222-2222-4222-8222-222222222222', text: 'אַייס' }]],
  [
    'duplicate id',
    [
      { id, text: 'אַייס' },
      { id, text: 'אַייס' },
    ],
  ],
  ['wrong script', [{ id, text: 'ice cream' }]],
  ['oversized text', [{ id, text: 'א'.repeat(501) }]],
] as const)
  test(`reading guide rejects ${name}`, async () => {
    const provider = new OpenAiReadingGuideProvider(
      'key',
      'model',
      { consume: async () => {} },
      async () => response(guides),
    );
    await assert.rejects(provider.generate(items, scope), { code: 'READING_GUIDE_UNAVAILABLE' });
  });
test('reading guide enforces batch bounds and quota before provider calls', async () => {
  assert.equal(readingGuideRequest.safeParse({ ids: [] }).success, false);
  assert.equal(readingGuideRequest.safeParse({ ids: Array(31).fill(id) }).success, false);
  assert.equal(readingGuideRequest.safeParse({ ids: [id], nativeLanguage: 'en' }).success, false);
  const provider = new OpenAiReadingGuideProvider(
    'key',
    'model',
    {
      consume: async () => {
        throw new Error('quota');
      },
    },
    async () => {
      throw new Error('must not fetch');
    },
  );
  await assert.rejects(provider.generate(items, scope), /quota/);
});
test('provider failure returns a safe unavailable error', async () => {
  const provider = new OpenAiReadingGuideProvider(
    'key',
    'model',
    { consume: async () => {} },
    async () => new Response('secret diagnostic', { status: 500 }),
  );
  await assert.rejects(provider.generate(items, scope), { code: 'READING_GUIDE_UNAVAILABLE' });
});
