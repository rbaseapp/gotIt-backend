import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenAiStudyImageProvider } from '../src/modules/practice/openai-study-image.provider.js';

const input = {
  sourceText: 'remember',
  translationText: 'לזכור',
  sourceLanguageCode: 'en',
  translationLanguageCode: 'he',
  context: 'I remember our first lesson.',
};

function webp() {
  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('WEBP', 'ascii'),
    Buffer.from('study-image'),
  ]);
}

test('OpenAI study images use a literal low-cost prompt and deduplicate concurrent work', async () => {
  let calls = 0;
  let requestBody: Record<string, unknown> = {};
  let authorization = '';
  const provider = new OpenAiStudyImageProvider('server-secret', 'gpt-image-2.5-flare', (async (
    _url: string | URL | Request,
    init?: RequestInit,
  ) => {
    calls++;
    authorization = new Headers(init?.headers).get('authorization') || '';
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ data: [{ b64_json: webp().toString('base64') }] });
  }) as typeof fetch);

  const [first, second] = await Promise.all([provider.generate(input), provider.generate(input)]);

  assert.equal(calls, 1);
  assert.equal(authorization, 'Bearer server-secret');
  assert.equal(requestBody.model, 'gpt-image-2.5-flare');
  assert.equal(requestBody.size, '512x512');
  assert.equal(requestBody.quality, 'low');
  assert.equal(requestBody.output_format, 'webp');
  assert.match(String(requestBody.prompt), /untrusted vocabulary data/u);
  assert.match(String(requestBody.prompt), /remember/u);
  assert.match(String(requestBody.prompt), /לזכור/u);
  assert.deepEqual(second, first);
  assert.equal(first?.contentType, 'image/webp');
  assert.equal(first?.data.toString('ascii', 0, 4), 'RIFF');
});

test('OpenAI study images fail closed for provider errors and invalid image bytes', async () => {
  const invalid = new OpenAiStudyImageProvider('server-secret', 'configured-model', (async () =>
    Response.json({
      data: [{ b64_json: Buffer.from('not-webp').toString('base64') }],
    })) as typeof fetch);
  const unavailable = new OpenAiStudyImageProvider(
    'server-secret',
    'configured-model',
    (async () => new Response(null, { status: 429 })) as typeof fetch,
  );

  assert.equal(await invalid.generate(input), null);
  assert.equal(await unavailable.generate(input), null);
});
