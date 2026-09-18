import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicReadingGenerator } from '../src/modules/reading/anthropic-reading.js';

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

const requestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'bodyText'],
  properties: {
    title: { type: 'string' },
    bodyText: { type: 'string' },
  },
};
