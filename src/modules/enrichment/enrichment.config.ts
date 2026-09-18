import { z } from 'zod';
import { EnrichmentRegistry } from './enrichment.registry.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { GoogleCloudTranslationProvider } from './providers/google-cloud.js';
import { SelectionProofs } from './selection-proof.js';
import type { EnrichmentProvider, ModelProfile } from './enrichment.types.js';

export const routingSchema = z
  .object({
    profiles: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            providerId: z.string().min(1).max(100),
            model: z.string().min(1).max(200).nullable(),
            timeoutMs: z.number().int().min(1).max(60000),
            structuredOutput: z.boolean().optional(),
            thinkingMode: z.enum(['adaptive', 'disabled']).optional(),
          })
          .strict(),
      )
      .max(30),
    routes: z
      .object({ auto: route().optional(), dictionary: route().optional(), ai: route().optional() })
      .strict(),
  })
  .strict();
function route() {
  return z
    .object({
      profiles: z.array(z.string().min(1).max(100)).min(1).max(5),
      timeoutMs: z.number().int().min(1).max(60000),
    })
    .strict();
}
export function createEnrichment(
  settings: {
    ANTHROPIC_API_KEY?: string;
    ANTHROPIC_WORKSPACE_ID?: string;
    AI_TRANSLATION_MODEL?: string;
    CLAUDE_STRUCTURED_OUTPUT?: boolean;
    ENRICHMENT_SIGNING_SECRET?: string;
    ENRICHMENT_PROFILES_JSON?: string;
    GOOGLE_TRANSLATION_API?: 'cloud_basic_v2';
    GOOGLE_TRANSLATE_API_KEY?: string;
    GOOGLE_TRANSLATION_LANGUAGES_JSON?: string;
  },
  additionalProviders: EnrichmentProvider[] = [],
) {
  if (!settings.ENRICHMENT_PROFILES_JSON) {
    if (settings.ANTHROPIC_API_KEY && !settings.AI_TRANSLATION_MODEL)
      throw new Error('ANTHROPIC_API_KEY requires AI_TRANSLATION_MODEL');
    if (settings.AI_TRANSLATION_MODEL && !settings.ANTHROPIC_API_KEY)
      throw new Error('AI_TRANSLATION_MODEL requires ANTHROPIC_API_KEY');
  }
  const providers = [...additionalProviders];
  if (settings.ANTHROPIC_API_KEY)
    providers.push(
      new AnthropicProvider(settings.ANTHROPIC_API_KEY, fetch, settings.ANTHROPIC_WORKSPACE_ID),
    );
  if (settings.GOOGLE_TRANSLATION_API) {
    if (!settings.GOOGLE_TRANSLATE_API_KEY)
      throw new Error('Configured Google translation requires credentials');
    const languages = settings.GOOGLE_TRANSLATION_LANGUAGES_JSON
      ? z
          .record(z.string().max(64), z.string().min(1).max(64))
          .parse(JSON.parse(settings.GOOGLE_TRANSLATION_LANGUAGES_JSON))
      : {};
    providers.push(
      new GoogleCloudTranslationProvider(settings.GOOGLE_TRANSLATE_API_KEY, languages),
    );
  }
  let profiles: ModelProfile[] = [];
  let routes: z.output<typeof routingSchema>['routes'] = {};
  if (settings.ENRICHMENT_PROFILES_JSON) {
    const configuration = routingSchema.parse(JSON.parse(settings.ENRICHMENT_PROFILES_JSON));
    profiles = configuration.profiles;
    routes = configuration.routes;
  } else {
    if (settings.AI_TRANSLATION_MODEL) {
      profiles.push({
        id: 'claude_default',
        providerId: 'anthropic',
        model: settings.AI_TRANSLATION_MODEL,
        timeoutMs: 20000,
        structuredOutput: settings.CLAUDE_STRUCTURED_OUTPUT ?? false,
      });
      routes = {
        ai: { profiles: ['claude_default'], timeoutMs: 20000 },
      };
    }
    if (settings.GOOGLE_TRANSLATION_API) {
      profiles.push({
        id: 'google_default',
        providerId: 'google_cloud_translation',
        model: null,
        timeoutMs: 5000,
      });
      routes.auto = { profiles: ['google_default'], timeoutMs: 5000 };
      routes.dictionary = { profiles: ['google_default'], timeoutMs: 5000 };
    }
  }
  if (profiles.length && !settings.ENRICHMENT_SIGNING_SECRET)
    throw new Error('Configured enrichment requires a GotIt signing secret');
  return {
    registry: new EnrichmentRegistry(providers, profiles, routes),
    proofs: new SelectionProofs(settings.ENRICHMENT_SIGNING_SECRET),
  };
}
