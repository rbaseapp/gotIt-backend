import { z } from 'zod';
import { candidateSchema, languageSchema, textSchema } from '../capture/capture.validation.js';
import type { EnrichmentInput, EnrichmentProvider, ModelProfile } from './enrichment.types.js';

const outputSchema = z
  .object({
    sourceLanguageCode: languageSchema.nullable(),
    candidates: z.array(candidateSchema).min(1).max(5),
    providerModel: textSchema(200).optional(),
  })
  .strict();
export type EnrichmentResult =
  | { status: 'not_configured' | 'needs_language_selection' | 'unavailable' }
  | {
      status: 'succeeded';
      output: z.output<typeof outputSchema>;
      provider: EnrichmentProvider;
      profile: ModelProfile;
      latencyMs: number;
    };
export type ProviderTrace = {
  provider: EnrichmentProvider;
  profile: ModelProfile;
  status: 'succeeded' | 'failed' | 'timed_out';
  latencyMs: number;
  sourceLanguageCode: string | null;
};
export type RouteConfig = { profiles: string[]; timeoutMs: number };

/** Vendor identity and model profiles stay outside the capture domain. */
export class EnrichmentRegistry {
  private readonly providers = new Map<string, EnrichmentProvider>();
  private readonly profiles = new Map<string, ModelProfile>();
  constructor(
    providers: EnrichmentProvider[] = [],
    profiles: ModelProfile[] = [],
    private readonly routes: Partial<Record<'auto' | 'dictionary' | 'ai', RouteConfig>> = {},
  ) {
    for (const provider of providers) {
      if (!/^[a-z][a-z0-9_]{0,99}$/u.test(provider.id) || this.providers.has(provider.id))
        throw new Error('Invalid or duplicate enrichment provider');
      this.providers.set(provider.id, provider);
    }
    for (const profile of profiles) {
      const provider = this.providers.get(profile.providerId);
      if (
        !provider ||
        this.profiles.has(profile.id) ||
        !profile.id ||
        profile.timeoutMs < 1 ||
        profile.timeoutMs > 60000 ||
        (provider.capabilities.models && !profile.model) ||
        (!provider.capabilities.models && profile.model !== null) ||
        (profile.structuredOutput && provider.kind !== 'ai') ||
        (profile.thinkingMode && provider.id !== 'anthropic')
      )
        throw new Error('Invalid enrichment model profile');
      this.profiles.set(profile.id, profile);
    }
    for (const [method, route] of Object.entries(routes)) {
      if (
        !route ||
        !route.profiles.length ||
        new Set(route.profiles).size !== route.profiles.length ||
        route.timeoutMs < 1 ||
        route.timeoutMs > 60000
      )
        throw new Error('Invalid enrichment route');
      for (const id of route.profiles) {
        const profile = this.profiles.get(id);
        const provider = profile && this.providers.get(profile.providerId);
        if (
          !provider ||
          (method === 'ai' && provider.kind !== 'ai') ||
          (method === 'dictionary' && provider.kind === 'ai')
        )
          throw new Error('Unknown or incompatible enrichment route profile');
      }
    }
  }
  async enrich(
    method: 'auto' | 'dictionary' | 'ai',
    input: EnrichmentInput,
    record: (trace: ProviderTrace) => Promise<void>,
  ): Promise<EnrichmentResult> {
    const route = this.routes[method];
    if (!route) return { status: 'not_configured' };
    const routeEnd = Date.now() + route.timeoutMs;
    let attempted = false;
    for (const id of route.profiles) {
      const profile = this.profiles.get(id)!;
      const provider = this.providers.get(profile.providerId)!;
      if (!input.sourceLanguageCode && !provider.capabilities.detection) continue;
      const remaining = routeEnd - Date.now();
      if (remaining <= 0) break;
      attempted = true;
      const started = Date.now();
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let output: z.output<typeof outputSchema> | undefined;
      let status: ProviderTrace['status'] = 'failed';
      try {
        output = await Promise.race([
          provider.enrich(input, profile, controller.signal).then((raw) => {
            // Aggregate budget also bounds tickets with five candidates.
            if (Buffer.byteLength(JSON.stringify(raw)) > 40000)
              throw new Error('Oversized provider output');
            const normalized = outputSchema.parse(raw);
            if (
              normalized.sourceLanguageCode === null ||
              (input.sourceLanguageCode !== null &&
                normalized.sourceLanguageCode !== input.sourceLanguageCode) ||
              normalized.candidates.some(
                (c) =>
                  (c.contextUsed && (!provider.capabilities.context || !input.sentenceText)) ||
                  (c.phoneticText !== null && !provider.capabilities.phonetics) ||
                  (c.examples.length > 0 &&
                    (!provider.capabilities.examples || provider.kind === 'translation_api')),
              )
            )
              throw new Error('Provider capability mismatch');
            return normalized;
          }),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => {
                controller.abort();
                reject(new Error('Enrichment deadline'));
              },
              Math.min(remaining, profile.timeoutMs),
            );
          }),
        ]);
        status = 'succeeded';
      } catch {
        status = controller.signal.aborted ? 'timed_out' : 'failed';
      } finally {
        if (timer) clearTimeout(timer);
      }
      const latencyMs = Math.max(0, Date.now() - started);
      // Recording errors propagate as database errors, never as provider fallback.
      const actualProfile = output?.providerModel
        ? { ...profile, model: output.providerModel }
        : profile;
      if (output?.providerModel && !provider.capabilities.models) {
        output = undefined;
        status = 'failed';
      }
      await record({
        provider,
        profile: actualProfile,
        status,
        latencyMs,
        sourceLanguageCode: output?.sourceLanguageCode ?? input.sourceLanguageCode,
      });
      if (output)
        return { status: 'succeeded', output, provider, profile: actualProfile, latencyMs };
    }
    return { status: attempted ? 'unavailable' : 'needs_language_selection' };
  }
}
