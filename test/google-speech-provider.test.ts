import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GoogleSpeechProvider,
  googleSpeechAssessment,
} from '../src/modules/speech/google-speech.provider.js';

test('Google speech synthesizes MP3 with the server-side key and configured voice', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const provider = new GoogleSpeechProvider('server-only-key', undefined, (async (url, init) => {
    requestUrl = String(url);
    requestInit = init;
    return Response.json({ audioContent: Buffer.from('test mp3').toString('base64') });
  }) as typeof fetch);
  assert.equal(provider.supports('en', 'listening'), true);
  assert.equal(provider.supports('he-IL', 'pronunciation'), false);
  assert.equal(provider.supports('fr', 'listening'), false);
  const result = await provider.synthesize('hello', 'en', new AbortController().signal);
  assert.equal(requestUrl, 'https://texttospeech.googleapis.com/v1/text:synthesize');
  assert.equal(new Headers(requestInit?.headers).get('X-Goog-Api-Key'), 'server-only-key');
  const body = JSON.parse(String(requestInit?.body));
  assert.deepEqual(body.input, { text: 'hello' });
  assert.deepEqual(body.voice, { languageCode: 'en-US', name: 'en-US-Standard-C' });
  assert.equal(result.contentType, 'audio/mpeg');
  assert.equal(result.audio.toString(), 'test mp3');
});

test('Google speech recognition produces an explicit transcript-confidence assessment', async () => {
  let requestInit: RequestInit | undefined;
  const provider = new GoogleSpeechProvider(
    'server-only-key',
    undefined,
    (async (url, init) => {
      assert.equal(String(url), 'https://speech.googleapis.com/v1/speech:recognize');
      requestInit = init;
      return Response.json({
        results: [
          {
            languageCode: 'en-US',
            alternatives: [
              {
                transcript: 'Good morning.',
                confidence: 0.9,
                words: [{ word: 'morning', confidence: 0.86 }],
              },
            ],
          },
        ],
      });
    }) as typeof fetch,
    async () => 'short-lived-access-token',
  );
  assert.equal(provider.supports('en', 'pronunciation'), true);
  const audio = Buffer.from('transient wav');
  const result = await provider.assess(
    { audio, text: 'good morning', language: 'en', idempotencyKey: 'event' },
    new AbortController().signal,
  );
  const body = JSON.parse(String(requestInit?.body));
  assert.equal(
    new Headers(requestInit?.headers).get('Authorization'),
    'Bearer short-lived-access-token',
  );
  assert.equal(new Headers(requestInit?.headers).get('X-Goog-Api-Key'), null);
  assert.equal(body.config.languageCode, 'en-US');
  assert.deepEqual(body.config.alternativeLanguageCodes, []);
  assert.equal(body.config.model, 'latest_short');
  assert.deepEqual(body.config.speechContexts, [{ phrases: ['good morning'], boost: 15 }]);
  assert.equal(body.audio.content, audio.toString('base64'));
  assert.equal(result.score, 99);
  assert.match(result.feedback, /התאמה 100/u);
  assert.match(result.feedback, /ביטחון זיהוי 90/u);
  assert.equal(result.model, 'google-stt-confidence-v1:en-US');
});

test('Google speech recognition uses the V1 Hebrew locale and supported short model', async () => {
  let requestInit: RequestInit | undefined;
  const provider = new GoogleSpeechProvider(
    'server-only-key',
    undefined,
    (async (_url, init) => {
      requestInit = init;
      return Response.json({ results: [] });
    }) as typeof fetch,
    async () => 'token',
  );
  await provider.assess(
    { audio: Buffer.from('wav'), text: 'שלום', language: 'he', idempotencyKey: 'event' },
    new AbortController().signal,
  );
  const body = JSON.parse(String(requestInit?.body));
  assert.equal(body.config.languageCode, 'iw-IL');
  assert.equal(body.config.model, 'command_and_search');
});

test('Google speech ignores a transcript labeled as a different language', async () => {
  const provider = new GoogleSpeechProvider(
    'server-only-key',
    undefined,
    (async () =>
      Response.json({
        results: [
          {
            languageCode: 'he-IL',
            alternatives: [{ transcript: 'שלום', confidence: 0.99 }],
          },
        ],
      })) as typeof fetch,
    async () => 'token',
  );
  const result = await provider.assess(
    { audio: Buffer.from('wav'), text: 'hello', language: 'en', idempotencyKey: 'event' },
    new AbortController().signal,
  );
  assert.equal(result.score, 0);
  assert.doesNotMatch(result.feedback, /שלום/u);
});

test('Google speech rejects a recognition locale from another language', () => {
  assert.throws(
    () =>
      new GoogleSpeechProvider(
        'server-only-key',
        JSON.stringify({
          en: {
            locale: 'en-US',
            recognitionLocale: 'he-IL',
          },
        }),
      ),
    /Recognition locale must match the configured source language/u,
  );
});

test('Google speech exposes safe actionable authentication failures', async () => {
  const provider = new GoogleSpeechProvider(
    'server-only-key',
    undefined,
    (async () =>
      Response.json(
        { error: { message: 'secret upstream detail' } },
        { status: 403 },
      )) as typeof fetch,
    async () => 'expired-token',
  );
  await assert.rejects(
    () =>
      provider.assess(
        { audio: Buffer.from('wav'), text: 'hello', language: 'en', idempotencyKey: 'event' },
        new AbortController().signal,
      ),
    (error: any) =>
      error.code === 'SPEECH_AUTH_FAILED' && !error.message.includes('secret upstream detail'),
  );
});

test('Google speech assessment is deterministic for mismatch and no recognition', () => {
  assert.deepEqual(googleSpeechAssessment('', 'hello', undefined), {
    score: 0,
    feedback: 'לא הצלחנו לזהות את המילה. נסו שוב לאט יותר ובסביבה שקטה.',
  });
  const mismatch = googleSpeechAssessment('yellow', 'hello', 0.95);
  assert.ok(mismatch.score < 85);
  assert.match(mismatch.feedback, /זוהה/u);
  assert.equal(googleSpeechAssessment('hello', 'hello', undefined).score, 85);
});
