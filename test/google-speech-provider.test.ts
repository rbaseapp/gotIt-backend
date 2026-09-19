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
  assert.equal(provider.supports('he-IL', 'pronunciation'), true);
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
  const provider = new GoogleSpeechProvider('server-only-key', undefined, (async (url, init) => {
    assert.equal(String(url), 'https://speech.googleapis.com/v1/speech:recognize');
    requestInit = init;
    return Response.json({
      results: [
        {
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
  }) as typeof fetch);
  const audio = Buffer.from('transient wav');
  const result = await provider.assess(
    { audio, text: 'good morning', language: 'en', idempotencyKey: 'event' },
    new AbortController().signal,
  );
  const body = JSON.parse(String(requestInit?.body));
  assert.equal(body.config.languageCode, 'en-US');
  assert.equal(body.audio.content, audio.toString('base64'));
  assert.equal(result.score, 99);
  assert.match(result.feedback, /התאמה 100/u);
  assert.match(result.feedback, /ביטחון זיהוי 90/u);
  assert.equal(result.model, 'google-stt-confidence-v1:en-US');
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
