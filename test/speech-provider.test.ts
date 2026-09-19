import assert from 'node:assert/strict';
import test from 'node:test';
import { AzureSpeechProvider } from '../src/modules/speech/azure-speech.provider.js';

test('Azure speech synthesizes escaped SSML only for configured languages', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const provider = new AzureSpeechProvider('secret-test-key', 'westeurope', undefined, (async (
    url,
    init,
  ) => {
    requestUrl = String(url);
    requestInit = init;
    return new Response(Buffer.from('test mp3'), {
      status: 200,
      headers: { 'Content-Type': 'audio/mpeg' },
    });
  }) as typeof fetch);
  assert.equal(provider.supports('en', 'listening'), true);
  assert.equal(provider.supports('en', 'pronunciation'), true);
  assert.equal(provider.supports('he', 'listening'), false);
  const result = await provider.synthesize('one < two & three', 'en', new AbortController().signal);
  assert.equal(requestUrl, 'https://westeurope.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.match(String(requestInit?.body), /one &lt; two &amp; three/u);
  assert.equal(
    new Headers(requestInit?.headers).get('Ocp-Apim-Subscription-Key'),
    'secret-test-key',
  );
  assert.equal(result.contentType, 'audio/mpeg');
  assert.equal(result.audio.toString(), 'test mp3');
});

test('Azure pronunciation sends transient PCM and returns bounded learner feedback', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const provider = new AzureSpeechProvider(
    'secret-test-key',
    'eastus',
    JSON.stringify({ en: { locale: 'en-US', voice: 'en-US-JennyNeural' } }),
    (async (url, init) => {
      requestUrl = String(url);
      requestInit = init;
      return Response.json({
        RecognitionStatus: 'Success',
        NBest: [
          {
            AccuracyScore: 83,
            FluencyScore: 91,
            CompletenessScore: 100,
            PronScore: 88.5,
            Words: [{ Word: 'morning', AccuracyScore: 72, ErrorType: 'Mispronunciation' }],
          },
        ],
      });
    }) as typeof fetch,
  );
  const audio = Buffer.from('transient audio');
  const result = await provider.assess(
    { audio, text: 'good morning', language: 'en', idempotencyKey: 'a'.repeat(64) },
    new AbortController().signal,
  );
  assert.match(requestUrl, /^https:\/\/eastus\.stt\.speech\.microsoft\.com\//u);
  assert.match(requestUrl, /language=en-US/u);
  assert.deepEqual(Buffer.from(requestInit?.body as Uint8Array), audio);
  const headers = new Headers(requestInit?.headers);
  assert.equal(headers.get('Content-Type'), 'audio/wav; codecs=audio/pcm; samplerate=16000');
  const parameters = JSON.parse(
    Buffer.from(headers.get('Pronunciation-Assessment')!, 'base64').toString('utf8'),
  );
  assert.equal(parameters.ReferenceText, 'good morning');
  assert.equal(result.score, 88.5);
  assert.match(result.feedback, /דיוק 83/u);
  assert.match(result.feedback, /morning \(72\)/u);
  assert.equal(result.model, 'azure-pronunciation-en-US');
});

test('Azure pronunciation is disabled for locales without assessment support', () => {
  const provider = new AzureSpeechProvider(
    'secret-test-key',
    'westeurope',
    JSON.stringify({ he: { locale: 'he-IL', voice: 'he-IL-HilaNeural' } }),
  );
  assert.equal(provider.supports('he', 'listening'), true);
  assert.equal(provider.supports('he', 'pronunciation'), false);
});
