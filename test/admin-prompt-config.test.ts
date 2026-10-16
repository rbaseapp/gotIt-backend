import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composePrompt,
  promptContentSchema,
  validatePromptContent,
} from '../src/modules/admin/admin.prompt-config.js';
import {
  promptPreviewSchema,
  previewRealtimePrompt,
} from '../src/modules/admin/admin.prompt-preview.js';
import { buildRealtimeLessonContract } from '../src/modules/private-lessons/private-lesson.realtime.js';
import { adminRuntimeContext } from '../src/modules/admin/admin.context.js';
import { adminAiFetch } from '../src/modules/admin/admin.ai-fetch.js';
import { PrivateLessonService } from '../src/modules/private-lessons/private-lesson.service.js';
import type { GotItProfile } from '../src/modules/profile/profile.types.js';
import type { Pool } from 'pg';
import pino from 'pino';

const defaults = { model: 'fixture-realtime', transcriptionModel: 'fixture-transcribe' };
const scope = {
  applicationId: '22222222-2222-4222-8222-222222222222',
  applicationUserId: '11111111-1111-4111-8111-111111111111',
};
const sample = {
  targetLanguageCode: 'en',
  supportLanguageCode: 'he',
  teachingLanguage: 'support' as const,
  topic: 'Food',
};
const content = validatePromptContent('lesson-live', {
  mode: 'replace',
  instructions: 'Tutor {{teacherName}} teaching {{targetLanguage}}. {{lessonData}}',
  modules: [
    { key: 'method', title: 'Method', enabled: true, text: 'CHECK ONE CONCEPT' },
    { key: 'disabled', title: 'Disabled', enabled: false, text: 'DO NOT INCLUDE' },
  ],
  realtime: {
    lessonDefaults: { requestedDurationMinutes: 5, speechRate: 'slow' },
    session: {
      model: 'fixture-override',
      max_output_tokens: 500,
      audio: {
        input: {
          transcription: { language: null, prompt: '{{targetLanguage}} and {{supportLanguage}}' },
          noise_reduction: null,
          turn_detection: { type: 'semantic_vad', eagerness: 'low', interrupt_response: false },
        },
        output: { voice: 'cedar', speed: 0.8 },
      },
    },
    stages: {
      opening: 'OPEN {{topic}}',
      continuation: '{{defaultDirective}} CONTINUE',
      wrapUp: 'CLOSE {{teacherName}}',
      translation: 'TRANSLATE {{supportLanguage}}',
    },
  },
});

test('legacy guidance, module ordering and literal single-pass variables remain predictable', () => {
  assert.equal(composePrompt('BASE', { instructions: '' }), 'BASE');
  assert.equal(composePrompt('BASE', { instructions: 'ADDED' }), 'BASE\n\nADDED');
  assert.equal(
    composePrompt(
      'BASE',
      {
        mode: 'replace',
        instructions: '{{baseInstructions}} / {{topic}}',
        modules: [{ key: 'one', title: 'One', enabled: true, text: 'LAST' }],
      },
      { topic: '{{baseInstructions}}' },
    ),
    'BASE / {{baseInstructions}}\n\nLAST',
  );
});
test('invalid models, unsupported fields, unsafe transport changes and unusable voice modes are rejected', () => {
  for (const session of [
    { model: 'https://other.test' },
    { audio: { output: { speed: 2 } } },
    { audio: { input: { turn_detection: null } } },
    { audio: { input: { turn_detection: { type: 'server_vad', create_response: false } } } },
    { tools: [] },
    { output_modalities: ['text'] },
    { apiKey: 'not-allowed' },
  ])
    assert.equal(
      promptContentSchema.safeParse({ instructions: '', realtime: { session } }).success,
      false,
    );
});
test('template mistakes, duplicate modules and empty replacements fail validation', () => {
  for (const candidate of [
    { instructions: '{{unknown}}' },
    { instructions: '{{defaultDirective}}' },
    { instructions: '', mode: 'replace' },
    {
      instructions: '',
      modules: [
        { key: 'x', title: 'One', enabled: true, text: '' },
        { key: 'x', title: 'Two', enabled: false, text: '' },
      ],
    },
  ])
    assert.equal(promptContentSchema.safeParse(candidate).success, false);
  assert.throws(() => validatePromptContent('reading', { instructions: '{{topic}}' }));
  assert.throws(() => validatePromptContent('reading', { instructions: '', realtime: {} }));
  assert.throws(
    () => composePrompt('x'.repeat(10000), { instructions: '{{baseInstructions}}'.repeat(30) }),
    { code: 'PROMPT_CONFIG_INVALID' },
  );
});
test('preview resolves app defaults and includes the actual session and every response directive without a provider call', () => {
  const result = previewRealtimePrompt(promptPreviewSchema.parse({ content, sample }), defaults);
  assert.equal(result.kind, 'synthetic-preview');
  assert.equal(result.resolvedLesson.durationSeconds, 300);
  assert.deepEqual(
    result.providerRequest.body.session,
    buildRealtimeLessonContract(result.resolvedLesson, defaults, content).session,
  );
  assert.match(result.providerRequest.body.session.instructions, /CHECK ONE CONCEPT/);
  assert.doesNotMatch(
    result.providerRequest.body.session.instructions,
    /DO NOT INCLUDE|# Role and objective/,
  );
  assert.equal(result.providerRequest.body.session.audio.input.noise_reduction, null);
  assert.equal('language' in result.providerRequest.body.session.audio.input.transcription, false);
  assert.equal(
    result.providerRequest.body.session.audio.input.turn_detection.create_response,
    true,
  );
  for (const event of Object.values(result.clientEvents))
    assert.match(event!.response.instructions, /CHECK ONE CONCEPT/);
  assert.match(result.clientEvents.opening.response.instructions, /OPEN Food/);
  assert.match(
    result.clientEvents.continuation.response.instructions,
    /Continue the current lesson/,
  );
  assert.match(result.clientEvents.wrapUp.response.instructions, /CLOSE Rachel/);
  assert.match(result.clientEvents.translation!.response.instructions, /TRANSLATE Hebrew/);
  assert.doesNotMatch(JSON.stringify(result), /Bearer|ek_/);
});
test('explicit learner choices precede admin defaults; invalid support combinations do not preview', () => {
  const result = previewRealtimePrompt(
    promptPreviewSchema.parse({ content, sample: { ...sample, requestedDurationMinutes: 15 } }),
    defaults,
  );
  assert.equal(result.resolvedLesson.durationSeconds, 900);
  assert.throws(() =>
    previewRealtimePrompt(
      promptPreviewSchema.parse({
        content,
        sample: { targetLanguageCode: 'en', teachingLanguage: 'support' },
      }),
      defaults,
    ),
  );
});
test('base sections can be individually extended, replaced or removed without freezing dynamic lesson policies', () => {
  const sectionContent = validatePromptContent('lesson-live', {
    instructions: 'GLOBAL',
    realtime: {
      sections: {
        role: '# Custom role\nTeacher {{teacherName}}',
        language: '{{defaultSection}}\nKEEP LANGUAGE',
        audio: '',
      },
    },
  });
  const result = previewRealtimePrompt(
    promptPreviewSchema.parse({ content: sectionContent, sample }),
    defaults,
  );
  assert.match(result.providerRequest.body.session.instructions, /# Custom role\nTeacher Rachel/);
  assert.match(result.providerRequest.body.session.instructions, /KEEP LANGUAGE/);
  assert.match(result.providerRequest.body.session.instructions, /TEACHING_LANGUAGE is Hebrew/);
  assert.doesNotMatch(result.providerRequest.body.session.instructions, /# Audio handling/);
  assert.ok(result.baseSections.some((section) => section.key === 'audio'));
  assert.ok(result.baseSections.every((section) => section.key));
});
test('replacement and modules apply to normal provider workloads while schemas and user input are preserved', async () => {
  let sent: any;
  const wrapped = adminAiFetch(
    { query: async () => ({ rows: [] }) } as unknown as Pool,
    'reading',
    pino({ enabled: false }),
    async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ usage: { input_tokens: 4 } });
    },
  );
  await adminRuntimeContext.run(
    {
      ...scope,
      requestId: 'fixture',
      prompts: {
        reading: {
          id: 'revision',
          instructions: 'REPLACED',
          mode: 'replace',
          modules: [{ key: 'style', title: 'Style', enabled: true, text: 'PLAIN' }],
        },
      },
    },
    () =>
      wrapped('https://api.openai.com/v1/responses', {
        body: JSON.stringify({
          instructions: 'BASE',
          input: 'UNTRUSTED USER INPUT',
          text: { format: { name: 'kept', type: 'json_schema' } },
        }),
      }),
  );
  assert.equal(sent.instructions, 'REPLACED\n\nPLAIN');
  assert.equal(sent.input, 'UNTRUSTED USER INPUT');
  assert.equal(sent.text.format.name, 'kept');
});
test('real lesson creation uses one scoped active configuration for the provider and all client events', async () => {
  const profile: GotItProfile = {
    defaultSourceLanguage: 'en',
    defaultTranslationLanguage: 'he',
    timezone: 'Asia/Jerusalem',
    dailyGoal: { type: 'minutes', value: 10 },
    defaultNewItemsPerDay: 10,
    translationMethodPreference: 'auto',
    languages: [],
    interests: [],
  };
  const bodies: any[] = [];
  const wrapped = adminAiFetch(
    { query: async () => ({ rows: [] }) } as unknown as Pool,
    'lesson-live',
    pino({ enabled: false }),
    async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ value: 'fixture-secret', expires_at: 2000000000 });
    },
  );
  const service = new PrivateLessonService({
    ...defaults,
    apiKey: 'fixture-key',
    voice: 'marin',
    profiles: { getProfile: async () => profile, patchProfile: async () => profile },
    vocabulary: { learned: async () => ({ items: [] }) },
    fetchImpl: wrapped,
  });
  const configured = await adminRuntimeContext.run(
    {
      ...scope,
      requestId: 'configured',
      prompts: { 'lesson-live': { ...content, id: 'active-revision' } },
    },
    () => service.createSession(scope, sample),
  );
  assert.equal(configured.lesson.durationSeconds, 300);
  assert.equal(configured.realtime.model, 'fixture-override');
  assert.equal(bodies[0].session.model, configured.realtime.model);
  assert.equal(bodies[0].session.instructions.match(/CHECK ONE CONCEPT/g).length, 1);
  for (const event of [
    configured.realtime.openingEvent,
    configured.realtime.continuationEvent,
    configured.realtime.wrapUpEvent,
    configured.realtime.translationEvent,
  ])
    assert.match(event!.response.instructions, /CHECK ONE CONCEPT/);
  const unconfigured = await adminRuntimeContext.run(
    { ...scope, requestId: 'another-request', prompts: {} },
    () => service.createSession(scope, sample),
  );
  assert.equal(unconfigured.realtime.model, defaults.model);
  assert.doesNotMatch(bodies[1].session.instructions, /CHECK ONE CONCEPT/);
});
