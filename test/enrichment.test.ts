import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EnrichmentRegistry,
  type ProviderTrace,
} from '../src/modules/enrichment/enrichment.registry.js';
import { createEnrichment } from '../src/modules/enrichment/enrichment.config.js';
import { AnthropicProvider } from '../src/modules/enrichment/providers/anthropic.js';
import type {
  EnrichmentProvider,
  ModelProfile,
} from '../src/modules/enrichment/enrichment.types.js';

const input = {
  sourceText: 'charge',
  sourceLanguageCode: 'en',
  translationLanguageCode: 'he',
  sentenceText: 'They charge a fee.',
};
const output = {
  sourceLanguageCode: 'en',
  candidates: [
    {
      text: 'fee',
      explanation: 'A concise explanation of the meaning in this sentence.',
      contextUsed: true,
    },
  ],
};
function provider(id: string, kind: 'ai' | 'translation_api' = 'ai'): EnrichmentProvider {
  return {
    id,
    kind,
    capabilities: {
      detection: false,
      context: kind === 'ai',
      phonetics: false,
      examples: kind === 'ai',
      models: kind === 'ai',
    },
    enrich: async (_input, profile) => ({
      sourceLanguageCode: 'en',
      candidates: [{ text: profile.model ?? 'translation', contextUsed: kind === 'ai' }],
    }),
  };
}
const profile = (
  id: string,
  providerId: string,
  model: string | null = 'test-model',
  timeoutMs = 1000,
): ModelProfile => ({ id, providerId, model, timeoutMs });
test('providers and model profiles can change without capture-specific vendor branches; class mismatch fails configuration', async () => {
  for (const [id, kind, model, method] of [
    ['another_translation', 'translation_api', null, 'dictionary'],
    ['anthropic', 'ai', 'model-one', 'ai'],
    ['anthropic', 'ai', 'model-two', 'ai'],
    ['additional_ai', 'ai', 'third-model', 'ai'],
  ] as const) {
    const traces: ProviderTrace[] = [];
    const registry = new EnrichmentRegistry(
      [provider(id, kind)],
      [profile('selected', id, model)],
      { [method]: { profiles: ['selected'], timeoutMs: 1000 } },
    );
    const result = await registry.enrich(method, input, async (trace) => {
      traces.push(trace);
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(traces[0]?.profile.model, model);
    assert.equal(traces[0]?.provider.id, id);
  }
  assert.throws(() => new EnrichmentRegistry([], [profile('bad', 'missing')]));
  assert.throws(
    () =>
      new EnrichmentRegistry([provider('ai')], [profile('chosen', 'ai')], {
        dictionary: { profiles: ['chosen'], timeoutMs: 1000 },
      }),
  );
  assert.throws(
    () =>
      new EnrichmentRegistry(
        [provider('api', 'translation_api')],
        [profile('chosen', 'api', null)],
        { ai: { profiles: ['chosen'], timeoutMs: 1000 } },
      ),
  );
  assert.throws(() =>
    createEnrichment({
      AI_TRANSLATION_MODEL: 'configured',
      ENRICHMENT_SIGNING_SECRET: 's'.repeat(32),
    }),
  );
  assert.deepEqual(
    await new EnrichmentRegistry().enrich('auto', input, async () => {
      throw new Error('No calls expected');
    }),
    { status: 'not_configured' },
  );
});
test('default Claude configuration serves only explicit AI while Google owns automatic translation', async () => {
  const configured = createEnrichment({
    ANTHROPIC_API_KEY: 'test-key',
    AI_TRANSLATION_MODEL: 'configured-model',
    ENRICHMENT_SIGNING_SECRET: 's'.repeat(32),
  });
  const registryConfig = configured.registry as unknown as {
    routes: Record<string, { profiles: string[]; timeoutMs: number }>;
  };
  assert.equal(registryConfig.routes.auto, undefined);
  assert.deepEqual(registryConfig.routes.ai, {
    profiles: ['claude_default'],
    timeoutMs: 20000,
  });

  const withGoogle = createEnrichment({
    ANTHROPIC_API_KEY: 'test-key',
    AI_TRANSLATION_MODEL: 'configured-model',
    GOOGLE_TRANSLATION_API: 'cloud_basic_v2',
    GOOGLE_TRANSLATE_API_KEY: 'google-test-key',
    ENRICHMENT_SIGNING_SECRET: 's'.repeat(32),
  }).registry as unknown as {
    routes: Record<string, { profiles: string[]; timeoutMs: number }>;
  };
  assert.deepEqual(withGoogle.routes.auto, {
    profiles: ['google_default'],
    timeoutMs: 5000,
  });
  assert.deepEqual(withGoogle.routes.dictionary, {
    profiles: ['google_default'],
    timeoutMs: 5000,
  });
  assert.deepEqual(withGoogle.routes.ai, {
    profiles: ['claude_default'],
    timeoutMs: 20000,
  });
  assert.throws(() => createEnrichment({ ANTHROPIC_API_KEY: 'test-key' }), /AI_TRANSLATION_MODEL/u);
});
test('Anthropic can detect a missing source language before translating', async () => {
  const adapter = new AnthropicProvider('test-only-key', async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    const supplied = JSON.parse(request.messages[0].content).untrustedTranslationData;
    assert.equal(supplied.sourceLanguageCode, null);
    return Response.json({
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(output) }],
    });
  });
  const registry = new EnrichmentRegistry(
    [adapter],
    [profile('chosen', 'anthropic', 'claude-sonnet-5')],
    { ai: { profiles: ['chosen'], timeoutMs: 1000 } },
  );
  const result = await registry.enrich(
    'ai',
    { ...input, sourceLanguageCode: null },
    async () => {},
  );
  assert.equal(result.status, 'succeeded');
});
test('fallback occurs only through a configured route and all attempts share one deadline with no retries', async () => {
  let firstCalls = 0,
    secondCalls = 0;
  const first = provider('first');
  first.enrich = async () => {
    firstCalls++;
    throw new Error('private upstream error');
  };
  const second = provider('second');
  second.enrich = async () => {
    secondCalls++;
    return output;
  };
  const profiles = [profile('first', 'first'), profile('second', 'second')];
  const noFallback = new EnrichmentRegistry([first, second], profiles, {
    auto: { profiles: ['first'], timeoutMs: 1000 },
  });
  assert.equal((await noFallback.enrich('auto', input, async () => {})).status, 'unavailable');
  assert.equal(secondCalls, 0);
  const fallback = new EnrichmentRegistry([first, second], profiles, {
    auto: { profiles: ['first', 'second'], timeoutMs: 1000 },
  });
  assert.equal((await fallback.enrich('auto', input, async () => {})).status, 'succeeded');
  assert.equal(firstCalls, 2);
  assert.equal(secondCalls, 1);
  let aborted = false;
  first.enrich = async (_input, _profile, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(new Error('private timeout'));
        },
        { once: true },
      );
    });
  const deadline = new EnrichmentRegistry([first, second], profiles, {
    auto: { profiles: ['first', 'second'], timeoutMs: 20 },
  });
  const traces: ProviderTrace[] = [];
  assert.equal(
    (
      await deadline.enrich('auto', input, async (trace) => {
        traces.push(trace);
      })
    ).status,
    'unavailable',
  );
  assert.equal(aborted, true);
  assert.equal(traces[0]?.status, 'timed_out');
  assert.equal(secondCalls, 1);
});
test('invalid output, oversized aggregate and false capabilities become manual unavailability; trace failures propagate', async () => {
  for (const raw of [
    {
      ...output,
      candidates: [{ text: 'fee', contextUsed: true, phoneticText: '/x/', phoneticScheme: 'ipa' }],
    },
    { ...output, candidates: [{ text: 'fee', variants: ['FEE'], contextUsed: true }] },
    {
      ...output,
      candidates: Array.from({ length: 6 }, () => ({ text: 'fee', contextUsed: true })),
    },
    { ...output, privatePrompt: 'must not appear' },
    {
      ...output,
      candidates: Array.from({ length: 5 }, () => ({
        text: 'fee',
        contextUsed: true,
        examples: Array.from({ length: 5 }, () => '字'.repeat(4000)),
      })),
    },
  ]) {
    const adapter = provider('test');
    adapter.enrich = async () => raw;
    const registry = new EnrichmentRegistry([adapter], [profile('test', 'test')], {
      ai: { profiles: ['test'], timeoutMs: 1000 },
    });
    assert.equal((await registry.enrich('ai', input, async () => {})).status, 'unavailable');
  }
  const registry = new EnrichmentRegistry([provider('test')], [profile('test', 'test')], {
    ai: { profiles: ['test'], timeoutMs: 1000 },
  });
  await assert.rejects(
    () =>
      registry.enrich('ai', input, async () => {
        throw new Error('database unavailable');
      }),
    /database unavailable/u,
  );
  assert.equal(
    (await registry.enrich('ai', { ...input, sourceLanguageCode: null }, async () => {})).status,
    'needs_language_selection',
  );
});
test('direct Anthropic uses configured model/schema and safe bounded output; refusal, truncation and upstream errors fail', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.anthropic.com/v1/messages');
    assert.equal(new Headers(init?.headers).get('anthropic-workspace-id'), 'wrkspc_test');
    const payload = JSON.parse(String(init?.body));
    assert.equal(payload.model, 'chosen-model');
    assert.equal(payload.max_tokens, 1200);
    assert.equal(payload.output_config.format.type, 'json_schema');
    assert.equal(payload.output_config.format.schema.properties.explanation.type, 'string');
    assert.equal(payload.output_config.format.schema.properties.candidates, undefined);
    const supplied = JSON.parse(payload.messages[0].content).untrustedTranslationData;
    assert.deepEqual(supplied, input);
    assert.equal('pageUrl' in supplied, false);
    return Response.json({
      model: 'actual-model-version',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(output) }],
    });
  };
  const adapter = new AnthropicProvider('test-only-key', fetchImpl, 'wrkspc_test');
  const registry = new EnrichmentRegistry(
    [adapter],
    [{ ...profile('chosen', 'anthropic', 'chosen-model'), structuredOutput: true }],
    { ai: { profiles: ['chosen'], timeoutMs: 1000 } },
  );
  const traces: ProviderTrace[] = [];
  const result = await registry.enrich('ai', input, async (trace) => {
    traces.push(trace);
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(calls, 1);
  assert.equal(traces[0]?.profile.model, 'actual-model-version');
  for (const response of [
    ...[401, 403, 429, 500, 503].map(
      (status) => () => new Response('secret provider error', { status }),
    ),
    () =>
      Response.json({
        model: 'chosen',
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: '{}' }],
      }),
    () =>
      Response.json({
        model: 'chosen',
        stop_reason: 'refusal',
        content: [{ type: 'text', text: 'private refusal' }],
      }),
    () =>
      Response.json({
        model: 'chosen',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'not json' }],
      }),
    () => new Response('a'.repeat(131073)),
  ]) {
    let failureCalls = 0;
    const failing = new AnthropicProvider('test-only-key', async () => {
      failureCalls++;
      return response();
    });
    const failureRegistry = new EnrichmentRegistry([failing], [profile('chosen', 'anthropic')], {
      ai: { profiles: ['chosen'], timeoutMs: 1000 },
    });
    assert.equal((await failureRegistry.enrich('ai', input, async () => {})).status, 'unavailable');
    assert.equal(failureCalls, 1);
  }
});
test('Anthropic authentication failures remain actionable without exposing the upstream body', async () => {
  const adapter = new AnthropicProvider(
    'test-only-key',
    async () => new Response('private provider error', { status: 401 }),
  );
  const registry = new EnrichmentRegistry(
    [adapter],
    [profile('chosen', 'anthropic', 'claude-haiku-4-5-20251001')],
    { ai: { profiles: ['chosen'], timeoutMs: 1000 } },
  );

  assert.deepEqual(await registry.enrich('ai', input, async () => {}), {
    status: 'unavailable',
    reason: 'authentication',
  });
});
test('Anthropic normalizes harmless whitespace, empty nullable fields and duplicate forms before strict validation', async () => {
  const adapter = new AnthropicProvider('test-only-key', async () =>
    Response.json({
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            sourceLanguageCode: ' en-US ',
            text: ' חִיּוּנִי ',
            variants: ['חִיּוּנִי', ' הֶכְרֵחִי ', 'הֶכְרֵחִי'],
            partOfSpeech: ' שם תואר ',
            explanation: '   ',
            contextUsed: true,
            examples: ['This is essential.', ' This is essential. '],
            harmlessExtraField: 'discarded',
          }),
        },
      ],
    }),
  );
  const registry = new EnrichmentRegistry(
    [adapter],
    [profile('chosen', 'anthropic', 'claude-sonnet-5')],
    { ai: { profiles: ['chosen'], timeoutMs: 1000 } },
  );

  const result = await registry.enrich('ai', input, async () => {});

  assert.equal(result.status, 'succeeded');
  if (result.status !== 'succeeded') return;
  assert.equal(result.output.sourceLanguageCode, 'en');
  assert.deepEqual(result.output.candidates[0], {
    text: 'חִיּוּנִי',
    variants: ['הֶכְרֵחִי'],
    partOfSpeech: 'שם תואר',
    explanation: null,
    phoneticText: null,
    phoneticScheme: null,
    examples: [],
    contextUsed: true,
  });
});
test('Anthropic requests niqqud but keeps a usable translation when optional niqqud is absent', async () => {
  const response = (body: unknown) =>
    Response.json({
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(body) }],
    });
  const translate = async (raw: unknown, enrichmentInput = input) => {
    const adapter = new AnthropicProvider('test-only-key', async () => response(raw));
    return new EnrichmentRegistry([adapter], [profile('chosen', 'anthropic', 'claude-sonnet-5')], {
      ai: { profiles: ['chosen'], timeoutMs: 1000 },
    }).enrich('ai', enrichmentInput, async () => {});
  };
  const hebrewTranslation = {
    sourceLanguageCode: 'en',
    text: 'חִיּוּב',
    variants: ['תַּשְׁלוּם'],
    partOfSpeech: 'שם עצם',
    explanation: 'סכום שנדרש לשלם.',
    phoneticText: null,
    phoneticScheme: null,
    contextUsed: true,
    examples: [],
  };
  assert.equal((await translate(hebrewTranslation)).status, 'succeeded');
  assert.equal((await translate({ ...hebrewTranslation, text: 'חיוב' })).status, 'succeeded');

  const hebrewSourceInput = {
    sourceText: 'ספר',
    sourceLanguageCode: 'he',
    translationLanguageCode: 'en',
    sentenceText: 'קראתי ספר חדש.',
  };
  const sourceResult = await translate(
    {
      sourceLanguageCode: 'he',
      text: 'book',
      variants: [],
      partOfSpeech: 'noun',
      explanation: 'A written work.',
      phoneticText: 'סֵפֶר',
      phoneticScheme: 'hebrew_niqqud',
      contextUsed: true,
      examples: [],
    },
    hebrewSourceInput,
  );
  assert.equal(sourceResult.status, 'succeeded');
  if (sourceResult.status === 'succeeded') {
    assert.equal(sourceResult.output.candidates[0]?.phoneticText, 'סֵפֶר');
    assert.equal(sourceResult.output.candidates[0]?.phoneticScheme, 'hebrew_niqqud');
  }
  assert.equal(
    (
      await translate(
        {
          sourceLanguageCode: 'he',
          text: 'book',
          variants: [],
          partOfSpeech: 'noun',
          explanation: 'A written work.',
          phoneticText: null,
          phoneticScheme: null,
          contextUsed: true,
          examples: [],
        },
        hebrewSourceInput,
      )
    ).status,
    'succeeded',
  );
});
test('Anthropic handles adaptive-thinking blocks and configurable thinking mode without leaking reasoning into candidates', async () => {
  for (const thinkingMode of [undefined, 'adaptive', 'disabled'] as const) {
    let calls = 0;
    const adapter = new AnthropicProvider('test-only', async (_url, init) => {
      calls++;
      const request = JSON.parse(String(init?.body));
      assert.deepEqual(request.thinking, thinkingMode ? { type: thinkingMode } : undefined);
      assert.equal(request.model, 'claude-sonnet-5');
      return Response.json({
        model: 'claude-sonnet-5',
        stop_reason: 'end_turn',
        content: [
          {
            type: 'thinking',
            thinking: 'Private internal reasoning, not translation JSON',
            signature: 'test-signature',
          },
          { type: 'redacted_thinking', data: 'redacted-private-data' },
          { type: 'text', text: JSON.stringify(output) },
        ],
      });
    });
    const registry = new EnrichmentRegistry(
      [adapter],
      [{ ...profile('chosen', 'anthropic', 'claude-sonnet-5'), thinkingMode }],
      { ai: { profiles: ['chosen'], timeoutMs: 1000 } },
    );
    const result = await registry.enrich('ai', input, async () => {});
    assert.equal(result.status, 'succeeded');
    assert.equal(calls, 1);
    assert.equal(
      JSON.stringify(result.status === 'succeeded' ? result.output : {}).includes(
        'Private internal reasoning',
      ),
      false,
    );
  }
  assert.throws(() =>
    createEnrichment(
      {
        ENRICHMENT_SIGNING_SECRET: 's'.repeat(32),
        ENRICHMENT_PROFILES_JSON: JSON.stringify({
          profiles: [{ ...profile('chosen', 'other'), thinkingMode: 'disabled' }],
          routes: { ai: { profiles: ['chosen'], timeoutMs: 1000 } },
        }),
      },
      [provider('other')],
    ),
  );
});
