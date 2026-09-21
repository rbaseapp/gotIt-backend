import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicReadingGenerator } from '../src/modules/reading/anthropic-reading.js';
import {
  bindReadingTargets,
  completeMissingTargets,
  targetRanges,
} from '../src/modules/reading/reading-content.js';
import { ReadingService } from '../src/modules/reading/reading.service.js';

const input = {
  topic: 'Travel',
  targetLanguageCode: 'en',
  contentType: 'article' as const,
  lengthPreset: 'short' as const,
  effectiveLevel: 'B1',
  targets: [
    {
      id: '27e5af51-6e91-43bd-a58d-a7cae7f1f741',
      sourceText: 'train station',
      translationText: 'תחנת רכבת',
      translationLanguageCode: 'he',
      partOfSpeech: 'noun',
      snapshotHash: 'a'.repeat(64),
    },
  ],
};

test('reading generation requests structured JSON when enabled', async () => {
  let request: Record<string, unknown> | undefined;
  const generator = new AnthropicReadingGenerator(
    'test-key',
    'claude-sonnet-5',
    true,
    async (_url, init) => {
      request = JSON.parse(String(init?.body));
      assert.equal(new Headers(init?.headers).get('anthropic-workspace-id'), 'wrkspc_test');
      return Response.json({
        model: 'claude-sonnet-5',
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              title: 'A short journey',
              bodyText: 'I arrived at the train station early enough to buy a ticket.',
            }),
          },
        ],
      });
    },
    'wrkspc_test',
  );

  const result = await generator.generate(input, new AbortController().signal);

  assert.deepEqual(request?.output_config, {
    format: { type: 'json_schema', schema: requestSchema },
  });
  assert.match(String(request?.system), /requiredTopic is mandatory/u);
  const messages = request?.messages as Array<{ content: string }>;
  const userPayload = JSON.parse(messages[0]?.content ?? '{}') as {
    untrustedReadingData?: {
      requiredTopic?: string;
      vocabularyTargets?: Array<{ text?: string }>;
    };
  };
  assert.equal(userPayload.untrustedReadingData?.requiredTopic, 'Travel');
  assert.equal(userPayload.untrustedReadingData?.vocabularyTargets?.[0]?.text, 'train station');
  assert.equal(result.providerModel, 'claude-sonnet-5');
  assert.match(result.bodyText, /train station/u);
});

test('reading generation accepts fenced JSON and ignores thinking blocks', async () => {
  const generator = new AnthropicReadingGenerator('test-key', 'claude-sonnet-5', false, async () =>
    Response.json({
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: 'omitted' },
        {
          type: 'text',
          text: '```json\n{"title":"A short journey","bodyText":"The train station was quiet in the early morning."}\n```',
        },
      ],
    }),
  );

  const result = await generator.generate(input, new AbortController().signal);

  assert.equal(result.title, 'A short journey');
  assert.match(result.bodyText, /train station/u);
});

test('reading generation retries without a stale optional workspace', async () => {
  const workspaceHeaders: Array<string | null> = [];
  const generator = new AnthropicReadingGenerator(
    'test-key',
    'claude-sonnet-5',
    false,
    async (_url, init) => {
      workspaceHeaders.push(new Headers(init?.headers).get('anthropic-workspace-id'));
      if (workspaceHeaders.length === 1)
        return Response.json(
          { error: { type: 'not_found_error', message: 'Workspace not found.' } },
          { status: 404 },
        );
      return Response.json({
        model: 'claude-sonnet-5',
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: '{"title":"A journey","bodyText":"The train station was busy."}',
          },
        ],
      });
    },
    'wrkspc_stale',
  );

  const result = await generator.generate(input, new AbortController().signal);

  assert.deepEqual(workspaceHeaders, ['wrkspc_stale', null]);
  assert.equal(result.title, 'A journey');
});

test('reading target matching tolerates harmless case, Unicode and whitespace variation', () => {
  assert.deepEqual(targetRanges('The TRAIN   STATION opened.', 'train station'), [
    { start: 4, end: 19 },
  ]);
  assert.equal(targetRanges('We ordered café.', 'café').length, 1);
});

test('missing reading targets are completed deterministically and rebound', () => {
  const content = completeMissingTargets(
    {
      title: 'A journey',
      bodyText: 'This valid passage deliberately starts without the required expression.',
    },
    input.targets,
  );
  assert.ok(content);
  const binding = bindReadingTargets(content.bodyText, input.targets);
  assert.equal(binding.missing.length, 0);
  assert.equal(binding.bound[0]?.sourceText, 'train station');
  assert.equal(binding.bound[0]?.occurrenceCount, 1);
});

test('repair generation sends the prior draft and exact missing targets as untrusted data', async () => {
  let supplied: Record<string, any> | undefined;
  const generator = new AnthropicReadingGenerator(
    'test-key',
    'claude-sonnet-5',
    false,
    async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      supplied = JSON.parse(request.messages[0].content).untrustedReadingData;
      return Response.json({
        model: 'claude-sonnet-5',
        stop_reason: 'end_turn',
        content: [
          {
            type: 'text',
            text: '{"title":"A journey","bodyText":"The train station was busy."}',
          },
        ],
      });
    },
  );
  await generator.generate(
    {
      ...input,
      repair: {
        previousTitle: 'Draft',
        previousBodyText: 'A draft without the target.',
        missingTargetTexts: ['train station'],
      },
    },
    new AbortController().signal,
  );
  assert.deepEqual(supplied?.repairRequest, {
    previousTitle: 'Draft',
    previousBodyText: 'A draft without the target.',
    missingTargetTexts: ['train station'],
  });
});

test('reading preview repairs omissions and salvages the valid draft if repair calls fail', async () => {
  const client = {
    query: async (query: string | { text: string }) => {
      const text = typeof query === 'string' ? query : query.text;
      if (text.includes('FROM product_gotit.learning_items'))
        return {
          rowCount: 1,
          rows: [
            {
              id: input.targets[0]!.id,
              source_text: 'train station',
              source_language_code: 'en',
              translation_language_code: 'he',
              user_status: 'active',
              deleted_at: null,
              learning_revision: 1,
              part_of_speech: 'noun',
              translations: ['תחנת רכבת'],
            },
          ],
        };
      return { rowCount: 0, rows: [] };
    },
    release: () => {},
  };
  const pool = { connect: async () => client } as any;
  const profiles = {
    getProfile: async () => ({
      defaultSourceLanguage: null,
      defaultTranslationLanguage: 'he',
      timezone: 'UTC',
      dailyGoal: { type: 'items', value: 5 },
      defaultNewItemsPerDay: 10,
      translationMethodPreference: 'auto',
      languages: [],
      interests: [],
    }),
  } as any;
  let calls = 0;
  const repairs: unknown[] = [];
  const service = new ReadingService(
    pool,
    profiles,
    {} as any,
    {
      id: 'test',
      generate: async (generationInput) => {
        calls++;
        repairs.push(generationInput.repair);
        if (calls > 1) throw new Error('temporary provider failure');
        return {
          title: 'A journey',
          bodyText: 'This is a valid draft about travel, but it omitted the selected expression.',
          providerModel: 'test-model',
        };
      },
    },
    's'.repeat(32),
  );
  const result = await service.preview(
    {
      applicationId: 'b6ee48fc-d538-4b49-8d31-f89f399342aa',
      applicationUserId: '455910fe-0d25-4ef8-8674-2bcc80aebf8e',
    },
    {
      topic: 'Travel',
      targetLanguageCode: 'en',
      contentType: 'article',
      lengthPreset: 'short',
      learningItemIds: [input.targets[0]!.id],
    },
  );
  assert.equal(calls, 3);
  assert.equal(repairs[0], undefined);
  assert.deepEqual((repairs[1] as { missingTargetTexts: string[] }).missingTargetTexts, [
    'train station',
  ]);
  assert.equal(result.reading.targets[0]?.occurrenceCount, 1);
  assert.match(result.reading.bodyText, /train station/u);
});

const requestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'bodyText'],
  properties: {
    title: { type: 'string' },
    bodyText: { type: 'string' },
  },
};
