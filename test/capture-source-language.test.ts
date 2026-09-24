import assert from 'node:assert/strict';
import test from 'node:test';
import { CaptureService } from '../src/modules/capture/capture.service.js';
import type { CaptureRepository } from '../src/modules/capture/capture.repository.js';
import { EnrichmentRegistry } from '../src/modules/enrichment/enrichment.registry.js';
import { SelectionProofs } from '../src/modules/enrichment/selection-proof.js';
import type {
  EnrichmentInput,
  EnrichmentProvider,
} from '../src/modules/enrichment/enrichment.types.js';
import type { ProfileServiceContract } from '../src/modules/profile/profile.types.js';

test('capture ignores page language metadata and auto-detects an equal source/target preference', async () => {
  let received: EnrichmentInput | undefined;
  const provider: EnrichmentProvider = {
    id: 'detecting_translation',
    kind: 'translation_api',
    capabilities: {
      detection: true,
      context: false,
      phonetics: false,
      examples: false,
      models: false,
    },
    enrich: async (input) => {
      received = input;
      return {
        sourceLanguageCode: input.sourceText === 'hello' ? 'en' : 'he',
        candidates: [{ text: 'שלום', contextUsed: false }],
      };
    },
  };
  const registry = new EnrichmentRegistry(
    [provider],
    [{ id: 'detect', providerId: provider.id, model: null, timeoutMs: 1000 }],
    { dictionary: { profiles: ['detect'], timeoutMs: 1000, maxAttempts: 1 } },
  );
  const repository = {
    recordEnrichment: async () => '11111111-1111-4111-8111-111111111111',
    findCandidates: async () => ({ items: [], hasMore: false }),
  } as unknown as CaptureRepository;
  const profiles = {
    getProfile: async () => ({
      defaultSourceLanguage: 'he',
      defaultTranslationLanguage: 'he',
      timezone: 'UTC',
      dailyGoal: { type: 'items' as const, value: 20 },
      defaultNewItemsPerDay: 10,
      translationMethodPreference: 'dictionary' as const,
      languages: [],
      interests: [],
    }),
    patchProfile: async () => {
      throw new Error('not used');
    },
  } satisfies ProfileServiceContract;
  const service = new CaptureService(
    repository,
    profiles,
    registry,
    new SelectionProofs('s'.repeat(32)),
  );

  const result = await service.preview(
    {
      applicationId: '22222222-2222-4222-8222-222222222222',
      applicationUserId: '33333333-3333-4333-8333-333333333333',
    },
    {
      selectedText: 'hello',
      documentLanguageHint: 'ar',
      translationMethod: 'dictionary',
    },
  );

  assert.equal(received?.sourceLanguageCode, null);
  assert.equal(received?.translationLanguageCode, 'he');
  assert.equal(result.sourceLanguageCode, 'en');
  assert.equal(result.sourceLanguageResolution, 'provider');
  assert.equal(result.enrichment.status, 'succeeded');

  const invalidDetection = await service.preview(
    {
      applicationId: '22222222-2222-4222-8222-222222222222',
      applicationUserId: '33333333-3333-4333-8333-333333333333',
    },
    {
      selectedText: 'obstacles',
      translationMethod: 'dictionary',
    },
  );
  assert.equal(invalidDetection.sourceLanguageCode, null);
  assert.equal(invalidDetection.sourceLanguageResolution, 'unresolved');
  assert.equal(invalidDetection.enrichment.status, 'needs_language_selection');
  assert.deepEqual(invalidDetection.enrichment.candidates, []);
  assert.equal(invalidDetection.requiresLanguageSelection, true);
});

test('capture starts the known-language existing-sense lookup while enrichment is running', async () => {
  let lookupStarted = false;
  let received: EnrichmentInput | undefined;
  const provider: EnrichmentProvider = {
    id: 'parallel_ai',
    kind: 'ai',
    capabilities: {
      detection: true,
      context: true,
      phonetics: true,
      examples: true,
      models: true,
    },
    enrich: async (input) => {
      received = input;
      assert.equal(lookupStarted, true);
      return {
        sourceLanguageCode: 'en',
        candidates: [{ text: 'שלום', contextUsed: true }],
      };
    },
  };
  const registry = new EnrichmentRegistry(
    [provider],
    [{ id: 'parallel', providerId: provider.id, model: 'test-model', timeoutMs: 1000 }],
    { ai: { profiles: ['parallel'], timeoutMs: 1000, maxAttempts: 1 } },
  );
  const repository = {
    recordEnrichment: async () => '11111111-1111-4111-8111-111111111111',
    findCandidates: async () => {
      lookupStarted = true;
      return { items: [], hasMore: false };
    },
  } as unknown as CaptureRepository;
  const profiles = {
    getProfile: async () => ({
      defaultSourceLanguage: 'en',
      defaultTranslationLanguage: 'he',
      timezone: 'UTC',
      dailyGoal: { type: 'items' as const, value: 20 },
      defaultNewItemsPerDay: 10,
      translationMethodPreference: 'ai' as const,
      languages: [],
      interests: [],
    }),
    patchProfile: async () => {
      throw new Error('not used');
    },
  } satisfies ProfileServiceContract;
  const service = new CaptureService(
    repository,
    profiles,
    registry,
    new SelectionProofs('s'.repeat(32)),
  );

  await service.preview(
    {
      applicationId: '22222222-2222-4222-8222-222222222222',
      applicationUserId: '33333333-3333-4333-8333-333333333333',
    },
    {
      selectedText: 'hello',
      translationMethod: 'ai',
      translationDetail: 'compact',
      context: {
        sentenceText: 'They said hello.',
        paragraphText: null,
        pageTitle: null,
        pageUrl: null,
      },
    },
  );

  assert.equal(received?.maxCandidates, 1);
});
