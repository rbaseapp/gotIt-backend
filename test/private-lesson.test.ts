import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { CoreAuthClient } from '../src/shared/core/core-auth.client.js';
import { ProviderHttpError } from '../src/modules/enrichment/providers/http.js';
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
import { PostgresPrivateLessonVocabularySource } from '../src/modules/private-lessons/private-lesson.repository.js';
import {
  buildPrivateLessonPrompt,
  type PrivateLessonPlan,
} from '../src/modules/private-lessons/private-lesson.prompt.js';
import type {
  PrivateLessonReport,
  PrivateLessonSummaryGenerator,
} from '../src/modules/private-lessons/private-lesson.summary.js';
import {
  OpenAiPrivateLessonSummaryGenerator,
  PrivateLessonSummaryError,
  privateLessonReportSchema,
} from '../src/modules/private-lessons/private-lesson.summary.js';
import {
  buildRoadmapBlueprint,
  privateLessonCurriculum,
} from '../src/modules/private-lessons/private-lesson.curriculum.js';
import { privateLessonRoadmapInputSchema } from '../src/modules/private-lessons/private-lesson.validation.js';
import { PostgresPrivateLessonRoadmapStore } from '../src/modules/private-lessons/private-lesson.roadmap.js';
import { taskLevelForPlan } from '../src/modules/private-lessons/private-lesson.assessment.js';

const assessment = privateLessonReportSchema.shape.assessment.parse({
  overallLevel: 'B1' as const,
  levelRange: { from: 'B1', to: 'B1' },
  confidence: 'medium' as const,
  evidenceSufficient: true,
  calibrationTarget: 'B2',
  basis: 'Broad independent evidence across the lesson.',
  lessonPerformance: {
    taskLevel: 'B1',
    score: 78,
    result: 'successful',
    evidenceQuality: 'moderate',
    independence: 75,
  },
  skills: {
    speaking: { score: 58, level: 'B1' as const, feedback: 'Clear spoken answers.' },
    vocabulary: { score: 55, level: 'B1' as const, feedback: 'Useful word choices.' },
    grammar: { score: 52, level: 'B1' as const, feedback: 'Mostly clear grammar.' },
    fluency: { score: 54, level: 'B1' as const, feedback: 'Keep extending answers.' },
    comprehension: { score: 60, level: 'B1' as const, feedback: 'Relevant responses.' },
  },
});

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
let recordedAssessment: { languageCode: string; level: string; confidence: number } | undefined;
const profiles: ProfileServiceContract = {
  getProfile: async () => profile,
  patchProfile: async () => profile,
  recordSystemAssessment: async (_scope, input) => {
    recordedAssessment = input;
  },
};
const vocabulary: PrivateLessonVocabularySource = {
  learned: async () => ({
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

const reportPlan: PrivateLessonPlan = {
  id: '66666666-6666-4666-8666-666666666666',
  durationSeconds: 300,
  targetLanguageCode: 'en',
  supportLanguageCode: 'he',
  lessonMode: 'standard',
  level: 'B1',
  topic: 'interviews',
  grammarFocus: null,
  focusAreas: ['speaking', 'vocabulary'],
  customFocus: null,
  correctionMode: 'recast',
  vocabularyMode: 'learned',
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
  continuity: null,
  roadmap: null,
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
    lessonMode: 'standard',
    requestedDurationMinutes: 10,
    teacherVoice: 'male',
    speechRate: 'very_slow',
    topic: 'job interviews',
    grammarFocus: 'past simple',
    focusAreas: ['speaking', 'grammar', 'fluency'],
    customFocus: 'Answer interview questions with longer examples',
    correctionMode: 'deep_explanation',
  });

  assert.equal(result.realtime.clientSecret, 'ek_demo');
  assert.equal(result.lesson.durationSeconds, 600);
  assert.equal(result.lesson.wrapUpAfterSeconds, 595);
  assert.equal(result.lesson.level, 'B1');
  assert.equal(result.lesson.teacherVoice, 'male');
  assert.equal(result.lesson.speechRate, 'very_slow');
  assert.deepEqual(result.lesson.focusAreas, ['speaking', 'grammar', 'fluency']);
  assert.equal(result.lesson.customFocus, 'Answer interview questions with longer examples');
  assert.equal(result.lesson.correctionMode, 'deep_explanation');
  assert.equal(result.lesson.vocabularyMode, 'learned');
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
  assert.deepEqual(
    (session.audio as { input: { noise_reduction: unknown } }).input.noise_reduction,
    { type: 'far_field' },
  );
  assert.deepEqual((session.audio as { input: { transcription: unknown } }).input.transcription, {
    model: 'gpt-transcribe-test',
    language: 'en',
    prompt:
      'The learner is speaking only American English. Transcribe the audio as American English; do not interpret it as another language.',
  });
  assert.deepEqual((session.audio as { output: unknown }).output, {
    voice: 'cedar',
    speed: 0.7,
  });
  assert.match(String(session.instructions), /job interviews/u);
  assert.match(String(session.instructions), /Your name is Mike/u);
  assert.match(result.realtime.openingEvent.response.instructions, /introduce yourself as Mike/u);
  assert.match(String(session.instructions), /achieve/u);
  assert.match(String(session.instructions), /DEEP CORRECTION AND EXPLANATION/u);
  assert.match(String(session.instructions), /explain the relevant grammar rule/u);
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

  const session = requestBody?.session as {
    instructions?: unknown;
    audio?: { input?: { transcription?: { language?: string } } };
  };
  const sessionInstructions = String(session.instructions);
  const openingInstructions = result.realtime.openingEvent.response.instructions;
  const closingInstructions = result.realtime.wrapUpEvent.response.instructions;
  const translationInstructions = result.realtime.translationEvent?.response.instructions ?? '';

  assert.equal(session.audio?.input?.transcription?.language, 'ar');
  assert.match(sessionInstructions, /TARGET_LANGUAGE is Arabic \(العربية; language code: ar\)/u);
  assert.match(sessionInstructions, /from the very first spoken word through the final goodbye/u);
  assert.match(sessionInstructions, /Every greeting, question, example, hint, correction/u);
  assert.match(openingInstructions, /Speak only in Arabic \(العربية; language code: ar\)/u);
  assert.match(openingInstructions, /very first spoken word/u);
  assert.match(closingInstructions, /Speak only in Arabic \(العربية; language code: ar\)/u);
  assert.match(translationInstructions, /translate .* into Hebrew \(עברית; language code: he\)/u);
  assert.match(translationInstructions, /entire most recent speaking turn/u);
  assert.match(translationInstructions, /every sentence/u);
  assert.match(translationInstructions, /resume speaking only in Arabic/u);
});

test('absolute beginner lesson teaches through the support language and accepts bilingual speech', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const service = makeService(async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ value: 'ek_demo' });
  });

  const result = await service.createSession(identity, {
    targetLanguageCode: 'es',
    supportLanguageCode: 'he',
    lessonMode: 'absolute_beginner',
    requestedLevel: 'B2',
  });

  const session = requestBody?.session as {
    instructions?: unknown;
    audio?: { input?: { transcription?: { language?: string; prompt?: string } } };
  };
  assert.equal(result.lesson.lessonMode, 'absolute_beginner');
  assert.equal(result.lesson.level, 'A1');
  assert.equal(session.audio?.input?.transcription?.language, undefined);
  assert.match(session.audio?.input?.transcription?.prompt ?? '', /Spanish or Hebrew/u);
  assert.match(String(session.instructions), /ABSOLUTE BEGINNER/u);
  assert.match(String(session.instructions), /Speak primarily in TEACHING_LANGUAGE/u);
  assert.match(String(session.instructions), /teach only 3-5 useful TARGET_LANGUAGE phrases/u);
  assert.match(
    result.realtime.openingEvent.response.instructions,
    /Greet, introduce yourself as Rachel, and explain the plan in Hebrew/u,
  );

  await assert.rejects(
    service.createSession(identity, {
      targetLanguageCode: 'es',
      supportLanguageCode: null,
      lessonMode: 'absolute_beginner',
    }),
    { code: 'PRIVATE_LESSON_SUPPORT_LANGUAGE_REQUIRED' },
  );
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
    speechRate: 'very_fast',
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
  assert.match(
    String((requestBody?.session as { instructions?: unknown }).instructions),
    /Your name is Rachel/u,
  );
  assert.match(result.realtime.openingEvent.response.instructions, /introduce yourself as Rachel/u);
  assert.equal(result.lesson.speechRate, 'very_fast');
  assert.deepEqual((requestBody?.session as { audio?: { output?: unknown } }).audio?.output, {
    voice: 'marin',
    speed: 1.4,
  });
});

test('private lesson can run without saved vocabulary and never loads acquiring words', async () => {
  let vocabularyRequested = false;
  let requestBody: Record<string, unknown> | undefined;
  const service = new PrivateLessonService({
    apiKey: 'server-secret',
    model: 'gpt-realtime-test',
    voice: 'marin',
    transcriptionModel: 'gpt-transcribe-test',
    profiles,
    vocabulary: {
      async learned() {
        vocabularyRequested = true;
        return { items: [] };
      },
    },
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ value: 'ek_demo' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const result = await service.createSession(identity, {
    targetLanguageCode: 'en',
    vocabularyMode: 'none',
  });

  assert.equal(vocabularyRequested, false);
  assert.equal(result.lesson.vocabularyMode, 'none');
  assert.deepEqual(result.lesson.targetWords, []);
  assert.match(
    String((requestBody?.session as { instructions?: unknown }).instructions),
    /"vocabularyMode": "none"/u,
  );
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

  const invalidCorrectionMode = await request(app)
    .post('/api/v1/private-lessons/realtime-sessions')
    .set('authorization', 'Bearer valid-token')
    .send({ targetLanguageCode: 'en', correctionMode: 'correct_every_word' })
    .expect(400);
  assert.equal(invalidCorrectionMode.body.error.code, 'VALIDATION_ERROR');

  const invalidVocabularyMode = await request(app)
    .post('/api/v1/private-lessons/realtime-sessions')
    .set('authorization', 'Bearer valid-token')
    .send({ targetLanguageCode: 'en', vocabularyMode: 'acquiring' })
    .expect(400);
  assert.equal(invalidVocabularyMode.body.error.code, 'VALIDATION_ERROR');

  const invalidSpeechRate = await request(app)
    .post('/api/v1/private-lessons/realtime-sessions')
    .set('authorization', 'Bearer valid-token')
    .send({ targetLanguageCode: 'en', speechRate: 'extreme' })
    .expect(400);
  assert.equal(invalidSpeechRate.body.error.code, 'VALIDATION_ERROR');

  const created = await request(app)
    .post('/api/v1/private-lessons/realtime-sessions')
    .set('authorization', 'Bearer valid-token')
    .send({ targetLanguageCode: 'en', topic: 'travel', speechRate: 'very_fast' })
    .expect(201);
  assert.equal(created.body.realtime.clientSecret, 'ek_demo');
  assert.equal(created.body.lesson.level, 'B1');
  assert.equal(created.body.lesson.durationSeconds, 300);
  assert.equal(created.body.lesson.speechRate, 'very_fast');
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
  recordedAssessment = undefined;
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
    assessment,
    roadmapProgress: null,
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
  const created = await service.createSession(identity, {
    targetLanguageCode: 'en',
    correctionMode: 'deep_explanation',
  });
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
  assert.deepEqual(recordedAssessment, {
    languageCode: 'en',
    level: 'B1',
    confidence: 0.7,
  });
  assert.equal(
    'turns' in (rows.get(created.lesson.id) as unknown as Record<string, unknown>),
    false,
  );
  assert.equal((await service.listSessions(identity, 20)).lessons.length, 1);
  const continued = await service.createSession(identity, {
    targetLanguageCode: 'en',
    focusAreas: ['grammar'],
  });
  assert.equal(continued.lesson.continuesFromLessonId, created.lesson.id);
  assert.equal(rows.get(continued.lesson.id)?.continuity?.nextLessonPlan, report.nextLessonPlan);
  assert.deepEqual(rows.get(continued.lesson.id)?.continuity?.vocabularyToReview, ['achieve']);
  assert.equal(continued.lesson.correctionMode, 'deep_explanation');
  assert.equal(continued.lesson.vocabularyMode, 'learned');
  assert.deepEqual(await service.removeSession(identity, created.lesson.id), { deleted: true });
  await assert.rejects(service.getSession(identity, created.lesson.id), {
    code: 'PRIVATE_LESSON_NOT_FOUND',
  });
});

test('private lesson report generation is structured, transient and limited to lesson vocabulary', async () => {
  let requestBody: Record<string, unknown> | undefined;
  const generated: PrivateLessonReport = {
    summary: 'סיכום שימושי.',
    assessment,
    roadmapProgress: null,
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
  const report = await generator.generate(
    reportPlan,
    [{ role: 'learner', text: 'I want to achieve my goal.' }],
    'safe-user-id',
  );

  assert.equal(requestBody?.store, false);
  assert.equal(requestBody?.max_output_tokens, 25_000);
  assert.deepEqual(requestBody?.reasoning, { effort: 'none' });
  assert.equal((requestBody?.text as { verbosity: string }).verbosity, 'low');
  assert.equal((requestBody?.text as { format: { strict: boolean } }).format.strict, true);
  assert.match(String(requestBody?.instructions), /server, not you, is the authority/u);
  assert.match(String(requestBody?.instructions), /0-100 scale, never 0-10/u);
  assert.match(
    String(requestBody?.instructions),
    /all user-facing report prose in Hebrew \(עברית; language code: he\)/u,
  );
  assert.match(String(requestBody?.instructions), /Never default report prose to English/u);
  assert.equal(
    (
      (
        requestBody?.input as Array<{
          content: string;
        }>
      )[0] &&
      JSON.parse((requestBody?.input as Array<{ content: string }>)[0]!.content).untrustedLessonData
    ).reportLanguageCode,
    'he',
  );
  assert.deepEqual(report.recommendedReviewItemIds, ['33333333-3333-4333-8333-333333333333']);
  assert.equal(report.vocabulary[0]?.sourceText, 'achieve');
  assert.deepEqual(
    report.newWordSuggestions.map((word) => word.sourceText),
    ['confident'],
  );
});

test('private lesson reports an exhausted output budget precisely', async () => {
  const generator = new OpenAiPrivateLessonSummaryGenerator(
    'summary-secret',
    'gpt-summary-test',
    async () =>
      new Response(
        JSON.stringify({
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          output: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );

  await assert.rejects(
    generator.generate(
      reportPlan,
      [{ role: 'learner', text: 'I want to achieve my goal.' }],
      'safe-user-id',
    ),
    (error: unknown) => {
      assert.ok(error instanceof PrivateLessonSummaryError);
      assert.equal(error.reason, 'output_limit');
      return true;
    },
  );
});

test('private lesson normalizes generated prose bounds before validating the report', async () => {
  const generated = {
    summary: `  ${'s'.repeat(2_100)}  `,
    assessment: {
      ...assessment,
      basis: 'b'.repeat(800),
      skills: Object.fromEntries(
        Object.entries(assessment.skills).map(([skill, value]) => [
          skill,
          {
            ...value,
            feedback: 'f'.repeat(600),
            evidence: [
              {
                learnerQuote: 'I want to achieve my goal.',
                observation: 'o'.repeat(600),
                independent: true,
              },
            ],
          },
        ]),
      ),
    },
    roadmapProgress: null,
    strengths: ['  clear answer  ', '', 'x'.repeat(600)],
    corrections: [{ original: ' ', corrected: 'fixed', explanation: 'empty source' }],
    grammarPoints: [],
    vocabulary: [
      {
        learningItemId: 'not-a-uuid',
        sourceText: 'invented',
        translationText: 'invented',
        outcome: 'practiced',
        note: 'invented',
      },
    ],
    newWordSuggestions: [],
    nextLessonPlan: 'n'.repeat(1_100),
    recommendedReviewItemIds: ['not-a-uuid'],
  };
  const generator = new OpenAiPrivateLessonSummaryGenerator(
    'summary-secret',
    'gpt-summary-test',
    async () =>
      Response.json({
        status: 'completed',
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(generated) }] }],
      }),
  );

  const report = await generator.generate(
    reportPlan,
    [{ role: 'learner', text: 'I want to achieve my goal.' }],
    'safe-user-id',
  );

  assert.equal(report.summary.length, 2_000);
  assert.equal(report.nextLessonPlan.length, 1_000);
  assert.deepEqual(
    report.strengths.map((strength) => strength.length),
    [12, 500],
  );
  assert.ok(report.assessment.skills.speaking.feedback.length <= 500);
  assert.ok(report.assessment.skills.speaking.evidence[0]!.observation.length <= 500);
  assert.deepEqual(report.corrections, []);
  assert.equal(report.vocabulary[0]?.learningItemId, reportPlan.targets[0]?.learningItemId);
  assert.deepEqual(report.recommendedReviewItemIds, []);
});

test('private lesson keeps a short imperfect answer as evidence without declaring a global level', async () => {
  const zeroAssessment = privateLessonReportSchema.shape.assessment.parse({
    overallLevel: 'A1' as const,
    confidence: 'low' as const,
    skills: Object.fromEntries(
      ['speaking', 'vocabulary', 'grammar', 'fluency', 'comprehension'].map((skill) => [
        skill,
        { score: 0, level: 'A1' as const, feedback: 'The sentence was incomplete.' },
      ]),
    ) as PrivateLessonReport['assessment']['skills'],
  });
  const generated: PrivateLessonReport = {
    summary: 'Short attempt.',
    assessment: zeroAssessment,
    roadmapProgress: null,
    strengths: [],
    corrections: [],
    grammarPoints: [],
    vocabulary: [],
    newWordSuggestions: [],
    nextLessonPlan: 'Try another answer.',
    recommendedReviewItemIds: [],
  };
  const generator = new OpenAiPrivateLessonSummaryGenerator(
    'summary-secret',
    'gpt-summary-test',
    async () =>
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [{ content: [{ type: 'output_text', text: JSON.stringify(generated) }] }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );

  const report = await generator.generate(
    reportPlan,
    [{ role: 'learner', text: 'Yesterday I go work, very tired.' }],
    'safe-user-id',
  );

  assert.ok(report.assessment.skills.speaking.score > 0);
  assert.ok(report.assessment.skills.grammar.score > 0);
  assert.equal(report.assessment.confidence, 'low');
  assert.equal(report.assessment.overallLevel, null);
  assert.equal(report.assessment.evidenceSufficient, false);
});

test('private lesson normalizes legacy ten-point scores and removes unsupported corrections', async () => {
  const generated = privateLessonReportSchema.parse({
    summary: 'Practice complete.',
    assessment: {
      overallLevel: 'A2',
      confidence: 'medium',
      skills: Object.fromEntries(
        ['speaking', 'vocabulary', 'grammar', 'fluency', 'comprehension'].map((skill) => [
          skill,
          {
            score: 7,
            level: 'A2',
            feedback: 'Useful evidence.',
            evidenceQuality: 'moderate',
            dimensions: null,
            evidence: [
              {
                learnerQuote: 'I explain my work and compare the options clearly.',
                observation: 'Independent response.',
                independent: true,
              },
            ],
          },
        ]),
      ),
    },
    roadmapProgress: null,
    strengths: [],
    corrections: [
      {
        original: 'I used a phrase that was never said.',
        corrected: 'A fabricated correction.',
        explanation: 'Unsupported.',
      },
    ],
    grammarPoints: [],
    vocabulary: [],
    newWordSuggestions: [],
    nextLessonPlan: 'Continue with an open response.',
    recommendedReviewItemIds: [],
  });
  const generator = new OpenAiPrivateLessonSummaryGenerator(
    'summary-secret',
    'gpt-summary-test',
    async () =>
      Response.json({
        status: 'completed',
        output: [{ content: [{ type: 'output_text', text: JSON.stringify(generated) }] }],
      }),
  );
  const turns = Array.from({ length: 6 }, () => ({
    role: 'learner' as const,
    text: 'I explain my work and compare the options clearly.',
  }));
  const report = await generator.generate(reportPlan, turns, 'safe-user-id');

  assert.ok(report.assessment.skills.speaking.score > 40);
  assert.equal(report.assessment.overallLevel, null);
  assert.deepEqual(report.corrections, []);
});

test('assessment uses the curriculum task level instead of the working profile level', () => {
  assert.equal(
    taskLevelForPlan({
      ...reportPlan,
      level: 'B2',
      grammarFocus: 'present-simple-continuous',
    }),
    'A1',
  );
});

test('private lesson computes roadmap completion separately from holistic level', async () => {
  const roadmapPlan: PrivateLessonPlan = {
    ...reportPlan,
    roadmap: {
      roadmapId: '77777777-7777-4777-8777-777777777777',
      milestoneId: '88888888-8888-4888-8888-888888888888',
      milestoneKey: 'foundation',
      goalTitle: 'Articles',
      communicationObjective: 'Choose a, an, or the in a short description',
      grammarTopics: ['articles'],
      successCriteria: { minimumLessons: 2, targetScore: 75 },
      evidenceLessonCount: 0,
      isFirstMilestoneLesson: true,
    },
  };
  const generated: PrivateLessonReport = {
    summary: 'Roadmap practice.',
    assessment,
    roadmapProgress: {
      objectiveCompletionScore: 80,
      targetFormControlScore: 70,
      score: 0,
      taskCompleted: false,
      confidence: 'medium',
      evidence: 'The learner described three objects with the target forms.',
    },
    strengths: [],
    corrections: [],
    grammarPoints: [],
    vocabulary: [],
    newWordSuggestions: [],
    nextLessonPlan: 'Recall the article choices.',
    recommendedReviewItemIds: [],
  };
  let requestBody: Record<string, unknown> | undefined;
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

  const report = await generator.generate(
    roadmapPlan,
    [{ role: 'learner', text: 'I see a book, an apple, and the teacher.' }],
    'safe-user-id',
  );

  assert.equal(report.roadmapProgress?.score, 77);
  assert.equal(report.roadmapProgress?.taskCompleted, true);
  const input = requestBody?.input as Array<{ content: string }>;
  assert.match(input[0]!.content, /"grammarTopics":\["articles"\]/u);
});

test('private lesson report timeout is categorized safely for retry diagnostics', async () => {
  const generator = new OpenAiPrivateLessonSummaryGenerator(
    'summary-secret',
    'gpt-summary-test',
    async (_url, init) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }),
    5,
  );

  await assert.rejects(
    generator.generate(
      reportPlan,
      [{ role: 'learner', text: 'I want to achieve my goal.' }],
      'safe-user-id',
    ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderHttpError);
      assert.equal(error.failureCode, 'timeout');
      return true;
    },
  );

  let savedFailureCode: string | undefined;
  const failedLesson = stored(reportPlan);
  const journal: PrivateLessonJournal = {
    async create() {},
    async get() {
      return failedLesson;
    },
    async list() {
      return [];
    },
    async claim() {
      return { ...failedLesson, status: 'summarizing' };
    },
    async complete() {
      throw new Error('must not complete');
    },
    async fail(_scope, _id, errorCode) {
      savedFailureCode = errorCode;
    },
    async remove() {
      return false;
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
    summaryGenerator: {
      async generate() {
        throw new ProviderHttpError(504, 'timeout');
      },
    },
  });

  await assert.rejects(
    service.completeSession(identity, reportPlan.id, {
      actualDurationSeconds: 300,
      completionReason: 'completed',
      turns: [{ role: 'learner', text: 'I want to achieve my goal.' }],
    }),
    {
      code: 'PRIVATE_LESSON_REPORT_FAILED',
      details: { reason: 'provider_timeout' },
    },
  );
  assert.equal(savedFailureCode, 'provider_timeout');
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

test('private lesson correction modes produce distinct tutoring behavior', () => {
  const base: PrivateLessonPlan = {
    id: '77777777-7777-4777-8777-777777777777',
    durationSeconds: 300,
    targetLanguageCode: 'en',
    supportLanguageCode: 'he',
    lessonMode: 'standard',
    level: 'B1',
    topic: 'travel',
    grammarFocus: null,
    focusAreas: ['speaking'],
    customFocus: null,
    correctionMode: 'recast',
    vocabularyMode: 'learned',
    teacherVoice: 'female',
    speechRate: 'normal',
    interests: [],
    targets: [],
    continuity: null,
  };

  const critical = buildPrivateLessonPrompt({ ...base, correctionMode: 'critical_only' });
  const recast = buildPrivateLessonPrompt(base);
  const deep = buildPrivateLessonPrompt({ ...base, correctionMode: 'deep_explanation' });

  assert.match(critical, /FREE CONVERSATION WITH CRITICAL CORRECTIONS ONLY/u);
  assert.match(critical, /Ignore minor grammar, wording, and style errors/u);
  assert.match(recast, /CORRECT MY SENTENCE/u);
  assert.match(recast, /natural, correct version of the sentence/u);
  assert.match(deep, /DEEP CORRECTION AND EXPLANATION/u);
  assert.match(deep, /why the original form was wrong/u);
});

test('private lesson curriculum exposes progressive grammar and communication paths', () => {
  const curriculum = privateLessonCurriculum('B1');
  assert.ok(curriculum.grammarTopics.some((topic) => topic.key === 'articles'));
  assert.ok(curriculum.grammarTopics.some((topic) => topic.key === 'modal-verbs'));
  assert.ok(curriculum.grammarTopics.some((topic) => topic.key === 'passive-voice'));
  assert.ok(curriculum.grammarTopics.some((topic) => topic.key === 'advanced-sentence-structure'));
  assert.ok(curriculum.communicationGoals.some((goal) => goal.key === 'everyday-conversation'));

  const roadmap = buildRoadmapBlueprint('grammar', 'conditionals', 'B1');
  assert.equal(roadmap.milestones.length, 5);
  assert.deepEqual(
    roadmap.milestones.map((milestone) => milestone.key),
    [
      'foundation',
      'guided-use',
      'controlled-conversation',
      'free-conversation',
      'independent-mastery',
    ],
  );
  assert.ok(
    roadmap.milestones.every((milestone) => milestone.successCriteria.minimumLessons === 2),
  );
  assert.ok(roadmap.milestones.every((milestone) => milestone.successCriteria.targetScore === 75));
});

test('first roadmap milestone lesson teaches the topic before conversation', () => {
  const prompt = buildPrivateLessonPrompt({
    ...reportPlan,
    level: 'A1',
    roadmap: {
      roadmapId: '77777777-7777-4777-8777-777777777777',
      milestoneId: '88888888-8888-4888-8888-888888888888',
      milestoneKey: 'foundation',
      goalTitle: 'Articles',
      communicationObjective: 'Use a, an, and the to identify familiar objects',
      grammarTopics: ['articles'],
      successCriteria: { minimumLessons: 2, targetScore: 75 },
      evidenceLessonCount: 0,
      isFirstMilestoneLesson: true,
    },
  });

  assert.match(prompt, /teach before starting the conversation/u);
  assert.match(prompt, /short explanation, sentence pattern, examples/u);
  assert.match(prompt, /only then independent speaking/u);
  assert.match(prompt, /Do not assume the learner already knows the name of the topic/u);
  assert.match(prompt, /"isFirstMilestoneLesson": true/u);
});

test('roadmap records only explicit completed-task evidence', async () => {
  let connected = false;
  const store = new PostgresPrivateLessonRoadmapStore({
    async connect() {
      connected = true;
      throw new Error('Incomplete tasks must not touch roadmap progress');
    },
  } as never);
  const lesson: PrivateLessonPlan = {
    ...reportPlan,
    roadmap: {
      roadmapId: '77777777-7777-4777-8777-777777777777',
      milestoneId: '88888888-8888-4888-8888-888888888888',
      milestoneKey: 'foundation',
      goalTitle: 'Articles',
      communicationObjective: 'Use articles to identify objects',
      grammarTopics: ['articles'],
      successCriteria: { minimumLessons: 2, targetScore: 75 },
      evidenceLessonCount: 0,
      isFirstMilestoneLesson: true,
    },
  };
  const report: PrivateLessonReport = {
    summary: 'The learner spoke well generally but did not complete the target task.',
    assessment,
    roadmapProgress: {
      objectiveCompletionScore: 60,
      targetFormControlScore: 90,
      score: 69,
      taskCompleted: false,
      confidence: 'high',
      evidence: 'The answer did not satisfy the communication objective.',
    },
    strengths: [],
    corrections: [],
    grammarPoints: [],
    vocabulary: [],
    newWordSuggestions: [],
    nextLessonPlan: 'Retry the task.',
    recommendedReviewItemIds: [],
  };

  await store.recordEvidence(identity, lesson, report);
  assert.equal(connected, false);
});

test('private lesson roadmap input rejects goals from the wrong catalog', () => {
  assert.equal(
    privateLessonRoadmapInputSchema.safeParse({
      targetLanguageCode: 'en',
      goalKind: 'grammar',
      goalKey: 'job-interviews',
    }).success,
    false,
  );
  assert.equal(
    privateLessonRoadmapInputSchema.safeParse({
      targetLanguageCode: 'en',
      goalKind: 'grammar',
      goalKey: 'gerund-infinitive',
    }).success,
    true,
  );
});

test('private lesson vocabulary source selects only active mastered words in the target language', async () => {
  let sql = '';
  let parameters: unknown[] = [];
  const source = new PostgresPrivateLessonVocabularySource({
    async query(statement: string, values: unknown[]) {
      sql = statement;
      parameters = values;
      return {
        rows: [
          {
            id: '88888888-8888-4888-8888-888888888888',
            source_text: 'achieve',
            source_language_code: 'en-US',
            primary_translation: 'להשיג',
          },
        ],
      };
    },
  } as never);

  const result = await source.learned(identity, 'en-US', 5);

  assert.match(sql, /user_status='active'/u);
  assert.match(sql, /learning_status='mastered'/u);
  assert.match(sql, /deleted_at IS NULL/u);
  assert.deepEqual(parameters, [identity.applicationId, identity.applicationUserId, 'en', 5]);
  assert.deepEqual(result.items, [
    {
      id: '88888888-8888-4888-8888-888888888888',
      sourceText: 'achieve',
      sourceLanguageCode: 'en-US',
      primaryTranslation: 'להשיג',
    },
  ]);
});
