import type { Candidate } from '../capture/capture.validation.js';

export type ProviderKind = 'translation_api' | 'dictionary' | 'ai';
export type EnrichmentInput = {
  sourceText: string;
  sourceLanguageCode: string | null;
  translationLanguageCode: string;
  sentenceText: string | null;
};
export type ProviderCapabilities = {
  detection: boolean;
  context: boolean;
  phonetics: boolean;
  examples: boolean;
  models: boolean;
};
export interface EnrichmentProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;
  enrich(input: EnrichmentInput, profile: ModelProfile, signal: AbortSignal): Promise<unknown>;
}
export type ModelProfile = {
  id: string;
  providerId: string;
  model: string | null;
  timeoutMs: number;
  structuredOutput?: boolean;
  thinkingMode?: 'adaptive' | 'disabled';
};
export type ProviderFacts = {
  providerName: string;
  providerType: ProviderKind;
  providerModel: string | null;
  runId: string;
  candidate: Candidate;
};
