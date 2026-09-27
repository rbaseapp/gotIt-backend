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
import type {
  PrivateLessonJournal,
  StoredPrivateLesson,
} from '../src/modules/private-lessons/private-lesson.repository.js';
import type { PrivateLessonPlan } from '../src/modules/private-lessons/private-lesson.prompt.js';
import type {
  PrivateLessonReport,
  PrivateLessonSummaryGenerator,
} from '../src/modules/private-lessons/private-lesson.summary.js';
import { OpenAiPrivateLessonSummaryGenerator } from '../src/modules/private-lessons/private-lesson.summary.js';

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
    requestedDurationMinutes: 10,
    teacherVoice: 'male',
    speechRate: 'slow',
    topic: 'job interviews',
    grammarFocus: 'past simple',
  });

  assert.equal(result.realtime.clientSecret, 'ek_demo');
  assert.equal(result.lesson.durationSeconds, 600);
  assert.equal(result.lesson.wrapUpAfterSeconds, 555);
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

test('private lesson pins every spoken response to the selected target language', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const service = makeService(async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ value: 'ek_demo' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  const result = await service.createSession(identity, {
    targetLanguageCode: 'ar',
    supportLanguageCode: 'he',
  });

  const session = requestBody?.session as { instructions?: unknown };
  const sessionInstructions = String(session.instructions);
  const openingInstructions = result.realtime.openingEvent.response.instructions;
  const closingInstructions = result.realtime.wrapUpEvent.response.instructions;
  const translationInstructions = result.realtime.translationEvent?.response.instructions ?? '';

  assert.match(sessionInstructions, /TARGET_LANGUAGE is Arabic \(العربية; language code: ar\)/u);
  assert.match(sessionInstructions, /from the very first spoken word through the final goodbye/u);
  assert.match(sessionInstructions, /Every greeting, question, example, hint, correction/u);
  assert.match(openingInstructions, /Speak only in Arabic \(العربية; language code: ar\)/u);
  assert.match(openingInstructions, /very first spoken word/u);
  assert.match(closingInstructions, /Speak only in Arabic \(العربية; language code: ar\)/u);
  assert.match(translationInstructions, /translate .* into Hebrew \(עברית; language code: he\)/u);
  assert.match(translationInstructions, /resume speaking only in Arabic/u);
});

test('private lesson omits translation action when no support language is available', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const service = makeService(async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ value: 'ek_demo' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const result = await service.createSession(identity, {
    targetLanguageCode: 'es',
    supportLanguageCode: null,
    teacherVoice: 'female',
    speechRate: 'fast',
  });

  assert.equal(result.realtime.translationEvent, null);
  assert.equal(result.lesson.supportLanguageCode, null);
  assert.match(
    String((requestBody?.session as { instructions?: unknown }).instructions),
    /No support language is configured.*Never speak in a language other than TARGET_LANGUAGE/su,
  );
  assert.match(
    String((requestBody?.session as { instructions?: unknown }).instructions),
    /explain more simply in TARGET_LANGUAGE without switching languages/u,
  );
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

  const invalidDuration = await request(app)
    .post('/api/v1/private-lessons/realtime-sessions')
    .set('authorization', 'Bearer valid-token')
    .send({ targetLanguageCode: 'en', requestedDurationMinutes: 2 })
    .expect(400);
  assert.equal(invalidDuration.body.error.code, 'VALIDATION_ERROR');

  const created = await request(app)
    .post('/api/v1/private-lessons/realtime-sessions')
    .set('authorization', 'Bearer valid-token')
    .send({ targetLanguageCode: 'en', topic: 'travel' })
    .expect(201);
  assert.equal(created.body.realtime.clientSecret, 'ek_demo');
  assert.equal(created.body.lesson.level, 'B1');
  assert.equal(created.body.lesson.durationSeconds, 300);
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

test('private lesson persists one structured report and never stores the transcript', async () => {
  const rows = new Map<string, StoredPrivateLesson>();
  const journal: PrivateLessonJournal = {
    async create(_scope, plan) {
      rows.set(plan.id, stored(plan));
    },
    async get(_scope, id) {
      return rows.get(id) ?? null;
    },
    async list() {
      return [...rows.values()];
    },
    async claim(_scope, id, duration) {
      const lesson = rows.get(id);
      if (!lesson || !['active', 'report_failed'].includes(lesson.status)) return null;
      const claimed = {
        ...lesson,
        status: 'summarizing' as const,
        actualDurationSeconds: duration,
        endedAt: new Date().toISOString(),
      };
      rows.set(id, claimed);
      return claimed;
    },
    async complete(_scope, id, report) {
      const lesson = rows.get(id)!;
      const completed = { ...lesson, status: 'completed' as const, report };
      rows.set(id, completed);
      return completed;
    },
    async fail(_scope, id) {
      const lesson = rows.get(id)!;
      rows.set(id, { ...lesson, status: 'report_failed' });
    },
    async remove(_scope, id) {
      return rows.delete(id);
    },
  };
  let generationCount = 0;
  const report: PrivateLessonReport = {
    summary: 'A useful lesson about interviews.',
    strengths: ['Clear short answers'],
    corrections: [],
    grammarPoints: [],
    vocabulary: [
      {
        learningItemId: '33333333-3333-4333-8333-333333333333',
        sourceText: 'achieve',
        translationText: 'להשיג',
        outcome: 'needs_review',
        note: 'Use it in one more sentence.',
      },
    ],
    newWordSuggestions: [],
    nextLessonPlan: 'Practice longer answers.',
    recommendedReviewItemIds: ['33333333-3333-4333-8333-333333333333'],
  };
  const summaryGenerator: PrivateLessonSummaryGenerator = {
    async generate(_plan, turns) {
      generationCount += 1;
      assert.equal(turns[0]?.text, 'I want to achieve my goal.');
      return report;
    },
  };
  const service = new PrivateLessonService({
    apiKey: 'server-secret',
    model: 'gpt-realtime-test',
    voice: 'marin',
    transcriptionModel: 'gpt-transcribe-test',
    profiles,
    vocabulary,
    journal,
    summaryGenerator,
    fetchImpl: async () =>
      new Response(JSON.stringify({ value: 'ek_demo' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  });
  const created = await service.createSession(identity, { targetLanguageCode: 'en' });
  const completion = {
    actualDurationSeconds: 142,
    completionReason: 'completed' as const,
    turns: [{ role: 'learner' as const, text: 'I want to achieve my goal.' }],
  };
  const first = await service.completeSession(identity, created.lesson.id, completion);
  const replay = await service.completeSession(identity, created.lesson.id, completion);

  assert.equal(generationCount, 1);
  assert.deepEqual(first.report, report);
  assert.deepEqual(replay.report, report);
  assert.equal(first.actualDurationSeconds, 142);
  assert.equal(
    'turns' in (rows.get(created.lesson.id) as unknown as Record<string, unknown>),
    false,
  );
  assert.equal((await service.listSessions(identity, 20)).lessons.length, 1);
  assert.deepEqual(await service.removeSession(identity, created.lesson.id), { deleted: true });
  await assert.rejects(service.getSession(identity, created.lesson.id), {
    code: 'PRIVATE_LESSON_NOT_FOUND',
  });
});

test('private lesson report generation is structured, transient and limited to lesson vocabulary', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const generated: PrivateLessonReport = {
    summary: 'סיכום שימושי.',
    strengths: ['דיברתם במשפטים ברורים.'],
    corrections: [],
    grammarPoints: [],
    vocabulary: [
      {
        learningItemId: '33333333-3333-4333-8333-333333333333',
        sourceText: 'forged text',
        translationText: 'forged translation',
        outcome: 'practiced',
        note: 'השתמשתם במילה בשיחה.',
      },
    ],
    newWordSuggestions: [
      { sourceText: 'achieve', translationText: 'כפילות', example: null },
      { sourceText: 'confident', translationText: 'בטוח', example: 'I feel confident.' },
    ],
    nextLessonPlan: 'להאריך את התשובות.',
    recommendedReviewItemIds: [
      '33333333-3333-4333-8333-333333333333',
      '55555555-5555-4555-8555-555555555555',
    ],
  };
  const generator = new OpenAiPrivateLessonSummaryGenerator(
    'summary-secret',
    'gpt-summary-test',
    async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          status: 'completed',
          output: [{ content: [{ type: 'output_text', text: JSON.stringify(generated) }] }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  );
  const plan: PrivateLessonPlan = {
    id: '66666666-6666-4666-8666-666666666666',
    durationSeconds: 300,
    targetLanguageCode: 'en',
    supportLanguageCode: 'he',
    level: 'B1',
    topic: 'interviews',
    grammarFocus: null,
    teacherVoice: 'female',
    speechRate: 'normal',
    interests: [],
    targets: [
      {
        learningItemId: '33333333-3333-4333-8333-333333333333',
        sourceText: 'achieve',
        translationText: 'להשיג',
      },
    ],
  };
  const report = await generator.generate(
    plan,
    [{ role: 'learner', text: 'I want to achieve my goal.' }],
    'safe-user-id',
  );

  assert.equal(requestBody?.store, false);
  assert.equal((requestBody?.text as { format: { strict: boolean } }).format.strict, true);
  assert.deepEqual(report.recommendedReviewItemIds, ['33333333-3333-4333-8333-333333333333']);
  assert.equal(report.vocabulary[0]?.sourceText, 'achieve');
  assert.deepEqual(
    report.newWordSuggestions.map((word) => word.sourceText),
    ['confident'],
  );
});

function stored(plan: PrivateLessonPlan): StoredPrivateLesson {
  return {
    ...plan,
    status: 'active',
    startedAt: new Date().toISOString(),
    endedAt: null,
    actualDurationSeconds: null,
    report: null,
  };
}
