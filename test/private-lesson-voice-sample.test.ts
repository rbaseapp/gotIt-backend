import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrivateLessonService } from '../src/modules/private-lessons/private-lesson.service.js';
import { privateLessonVoiceSampleSchema } from '../src/modules/private-lessons/private-lesson.validation.js';
import { AppError } from '../src/shared/errors/app-error.js';
const owner = { applicationId: randomUUID(), applicationUserId: randomUUID() };
const base = {
  apiKey: 'fixture',
  model: 'fixture',
  voice: 'fixture',
  transcriptionModel: 'fixture',
  profiles: {
    getProfile: async () => {
      throw new Error('No profile read expected');
    },
    patchProfile: async () => {
      throw new Error('No profile write expected');
    },
  },
  vocabulary: { learned: async () => ({ items: [] }) },
};
test('teacher sample uses the configured real voice and only fixed text, caches public audio and creates no lesson', async () => {
  const voices: string[] = [],
    quotas: string[] = [];
  const service = new PrivateLessonService({
    ...base,
    dailyQuota: {
      consume: async (scope, feature) => {
        assert.deepEqual(scope, owner);
        quotas.push(feature);
      },
    },
    fetchImpl: async (url, request) => {
      assert.equal(url, 'https://api.openai.com/v1/audio/speech');
      const body = JSON.parse(String(request?.body));
      voices.push(body.voice);
      assert.match(body.input, /your AI language teacher/);
      assert.equal(body.model, 'gpt-4o-mini-tts');
      return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } });
    },
  });
  assert.equal((await service.voiceSample(owner, 'female')).audioBase64, 'AQID');
  await service.voiceSample(owner, 'female');
  await service.voiceSample(owner, 'male');
  assert.deepEqual(voices, ['marin', 'cedar']);
  assert.equal(quotas.length, 2);
  assert.equal(
    privateLessonVoiceSampleSchema.safeParse({ teacherVoice: 'female', text: 'arbitrary text' })
      .success,
    false,
  );
});
test('teacher sample rejects quota before provider access and never hides a quota error', async () => {
  const service = new PrivateLessonService({
    ...base,
    dailyQuota: {
      consume: async () => {
        throw new AppError(429, 'AI_DAILY_LIMIT_REACHED', 'Limit');
      },
    },
    fetchImpl: async () => {
      throw new Error('Provider must not be reached');
    },
  });
  await assert.rejects(
    service.voiceSample(owner, 'male'),
    (error) => error instanceof AppError && error.statusCode === 429,
  );
});
test('teacher sample has bounded bytes, timeout and provider failure without storing broken audio', async () => {
  for (const response of [
    new Response('error', { status: 500 }),
    new Response('', { headers: { 'content-type': 'audio/mpeg' } }),
    new Response(new Uint8Array(1_000_001), { headers: { 'content-type': 'audio/mpeg' } }),
  ]) {
    const service = new PrivateLessonService({ ...base, fetchImpl: async () => response });
    await assert.rejects(
      service.voiceSample(owner, 'female'),
      (error) => error instanceof AppError && error.code === 'SPEECH_UNAVAILABLE',
    );
  }
  const service = new PrivateLessonService({
    ...base,
    requestTimeoutMs: 5,
    fetchImpl: async () => new Promise(() => {}),
  });
  await assert.rejects(
    service.voiceSample(owner, 'female'),
    (error) => error instanceof AppError && error.code === 'SPEECH_UNAVAILABLE',
  );
});
