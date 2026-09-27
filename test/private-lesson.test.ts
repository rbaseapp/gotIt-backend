import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { CoreAuthClient } from '../src/shared/core/core-auth.client.js';
import type { GotItProfile, ProfileServiceContract } from '../src/modules/profile/profile.types.js';
import {
  PrivateLessonService,
  type PrivateLessonVocabularySource,
} from '../src/modules/private-lessons/private-lesson.service.js';
import { privateLessonDemoJs } from '../src/modules/private-lessons/private-lesson.demo.js';

const logger = pino({ enabled: false });
const identity = {
  applicationId: '22222222-2222-4222-8222-222222222222',
  applicationUserId: '11111111-1111-4111-8111-111111111111',
  role: 'user' as const,
};
const profile: GotItProfile = {
  defaultSourceLanguage: 'en',
  defaultTranslationLanguage: 'he',
  timezone: 'Asia/Jerusalem',
  dailyGoal: { type: 'minutes', value: 10 },
  defaultNewItemsPerDay: 10,
  translationMethodPreference: 'auto',
  languages: [
    {
      languageCode: 'en',
      selfAssessedLevel: 'B1',
      systemEstimatedLevel: null,
      effectiveLevel: 'B1',
      systemConfidence: null,
      lastEvaluatedAt: null,
    },
  ],
  interests: ['technology', 'travel'],
};
const profiles: ProfileServiceContract = {
  getProfile: async () => profile,
  patchProfile: async () => profile,
};
const vocabulary: PrivateLessonVocabularySource = {
  queue: async () => ({
    items: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        sourceText: 'achieve',
        sourceLanguageCode: 'en',
        primaryTranslation: 'להשיג',
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        sourceText: 'viajar',
        sourceLanguageCode: 'es',
        primaryTranslation: 'לטייל',
      },
    ],
  }),
};

function makeCoreAuthClient() {
  return new CoreAuthClient({
    baseUrl: 'https://core.example.test',
    applicationKey: 'gotit',
    timeoutMs: 1000,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          user: {
            id: identity.applicationUserId,
            applicationId: identity.applicationId,
            email: 'user@example.test',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  });
}

function makeService(fetchImpl: typeof fetch, apiKey = 'server-secret') {
  return new PrivateLessonService({
    apiKey,
    model: 'gpt-realtime-test',
    voice: 'marin',
    transcriptionModel: 'gpt-transcribe-test',
    profiles,
    vocabulary,
    fetchImpl,
  });
}

test('private lesson creates a bounded personalized Realtime session', async () => {
  let requestBody: Record<string, unknown> | undefined;
  let requestHeaders: Headers | undefined;
  const service = makeService(async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requestHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ value: 'ek_demo', expires_at: 2_000_000_000 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const result = await service.createSession(identity, {
    targetLanguageCode: 'en-US',
    supportLanguageCode: 'he',
    teacherVoice: 'male',
    speechRate: 'slow',
    topic: 'job interviews',
    grammarFocus: 'past simple',
  });

  assert.equal(result.realtime.clientSecret, 'ek_demo');
  assert.equal(result.lesson.durationSeconds, 300);
  assert.equal(result.lesson.wrapUpAfterSeconds, 255);
  assert.equal(result.lesson.level, 'B1');
  assert.equal(result.lesson.teacherVoice, 'male');
  assert.equal(result.lesson.speechRate, 'slow');
  assert.equal(result.realtime.translationEvent?.type, 'response.create');
  assert.deepEqual(result.lesson.targetWords, [
    {
      learningItemId: '33333333-3333-4333-8333-333333333333',
      sourceText: 'achieve',
      translationText: 'להשיג',
    },
  ]);
  assert.equal(requestHeaders?.get('authorization'), 'Bearer server-secret');
  assert.match(requestHeaders?.get('openai-safety-identifier') ?? '', /^[a-f0-9]{64}$/u);

  const session = requestBody?.session as Record<string, unknown>;
  assert.equal(session.model, 'gpt-realtime-test');
  assert.deepEqual((session.audio as { output: unknown }).output, {
    voice: 'cedar',
    speed: 0.85,
  });
  assert.match(String(session.instructions), /job interviews/u);
  assert.match(String(session.instructions), /achieve/u);
  assert.doesNotMatch(JSON.stringify(result), /server-secret/u);
});

test('private lesson omits translation action when no support language is available', async () => {
  const service = makeService(
    async () =>
      new Response(JSON.stringify({ value: 'ek_demo' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const result = await service.createSession(identity, {
    targetLanguageCode: 'he',
    teacherVoice: 'female',
    speechRate: 'fast',
  });

  assert.equal(result.realtime.translationEvent, null);
  assert.equal(result.lesson.teacherVoice, 'female');
  assert.equal(result.lesson.speechRate, 'fast');
});

test('private lesson route is authenticated and validates language choices', async () => {
  const service = makeService(
    async () =>
      new Response(JSON.stringify({ value: 'ek_demo' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const app = createApp({
    logger,
    coreAuthClient: makeCoreAuthClient(),
    profileService: profiles,
    privateLessonService: service,
    enforcePaidEntitlements: false,
    checkDatabase: async () => undefined,
  });

  await request(app)
    .post('/api/v1/private-lessons/realtime-sessions')
    .send({
      targetLanguageCode: 'en',
    })
    .expect(401);

  const invalid = await request(app)
    .post('/api/v1/private-lessons/realtime-sessions')
    .set('authorization', 'Bearer valid-token')
    .send({ targetLanguageCode: 'en-US', supportLanguageCode: 'en-GB' })
    .expect(400);
  assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');

  const created = await request(app)
    .post('/api/v1/private-lessons/realtime-sessions')
    .set('authorization', 'Bearer valid-token')
    .send({ targetLanguageCode: 'en', topic: 'travel' })
    .expect(201);
  assert.equal(created.body.realtime.clientSecret, 'ek_demo');
  assert.equal(created.body.lesson.level, 'B1');
  assert.equal(created.body.lesson.targetWords[0].sourceText, 'achieve');
});

test('private lesson demo is public but keeps API access authenticated', async () => {
  assert.doesNotThrow(() => new Function(privateLessonDemoJs));
  const service = makeService(
    async () =>
      new Response(JSON.stringify({ value: 'ek_demo' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  const app = createApp({
    logger,
    coreAuthClient: makeCoreAuthClient(),
    profileService: profiles,
    privateLessonService: service,
    enforcePaidEntitlements: false,
    checkDatabase: async () => undefined,
  });

  const page = await request(app).get('/demo/private-lesson').expect(200);
  assert.match(page.text, /GotIt Voice POC/u);
  assert.match(page.headers['content-security-policy'] ?? '', /https:\/\/api\.openai\.com/u);
  await request(app).get('/demo/private-lesson.js').expect(200);
  await request(app)
    .post('/api/v1/private-lessons/realtime-sessions')
    .send({
      targetLanguageCode: 'en',
    })
    .expect(401);
});

test('private lesson hides provider authentication details', async () => {
  const service = makeService(
    async () =>
      new Response(JSON.stringify({ error: { message: 'invalid secret key sk-sensitive' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
  );

  await assert.rejects(
    service.createSession(identity, { targetLanguageCode: 'en' }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'PRIVATE_LESSON_PROVIDER_AUTHENTICATION');
      assert.doesNotMatch((error as Error).message, /sk-sensitive/u);
      return true;
    },
  );
});
