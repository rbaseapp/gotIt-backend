import { z } from 'zod';
import { EnrichmentRegistry } from './enrichment.registry.js';
import { GoogleCloudTranslationProvider } from './providers/google-cloud.js';
import { OpenAIProvider } from './providers/openai.js';
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
      maxAttempts: z.number().int().min(1).max(3).optional(),
    })
    .strict();
}
export function createEnrichment(
  settings: {
    OPENAI_API_KEY?: string;
    OPENAI_TRANSLATION_MODEL?: string;
    ENRICHMENT_SIGNING_SECRET?: string;
    ENRICHMENT_PROFILES_JSON?: string;
    GOOGLE_TRANSLATION_API?: 'cloud_basic_v2';
    GOOGLE_TRANSLATE_API_KEY?: string;
    GOOGLE_TRANSLATION_LANGUAGES_JSON?: string;
  },
  additionalProviders: EnrichmentProvider[] = [],
) {
  if (!settings.ENRICHMENT_PROFILES_JSON) {
    if (settings.OPENAI_API_KEY && !settings.OPENAI_TRANSLATION_MODEL)
      throw new Error('OPENAI_API_KEY requires OPENAI_TRANSLATION_MODEL');
    if (settings.OPENAI_TRANSLATION_MODEL && !settings.OPENAI_API_KEY)
      throw new Error('OPENAI_TRANSLATION_MODEL requires OPENAI_API_KEY');
  }
  const providers = [...additionalProviders];
  const googleTranslationEnabled = Boolean(
    settings.GOOGLE_TRANSLATION_API || settings.GOOGLE_TRANSLATE_API_KEY,
  );
  if (settings.OPENAI_API_KEY) providers.push(new OpenAIProvider(settings.OPENAI_API_KEY));
  if (googleTranslationEnabled) {
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
    if (settings.OPENAI_TRANSLATION_MODEL) {
      profiles.push({
        id: 'openai_default',
        providerId: 'openai',
        model: settings.OPENAI_TRANSLATION_MODEL,
        timeoutMs: 20000,
        structuredOutput: true,
      });
      routes = {
        ai: { profiles: ['openai_default'], timeoutMs: 30000, maxAttempts: 2 },
      };
    }
    if (googleTranslationEnabled) {
      profiles.push({
        id: 'google_default',
        providerId: 'google_cloud_translation',
        model: null,
        timeoutMs: 5000,
      });
      routes.auto = { profiles: ['google_default'], timeoutMs: 10000, maxAttempts: 2 };
      routes.dictionary = { profiles: ['google_default'], timeoutMs: 10000, maxAttempts: 2 };
    }
  }
  if (profiles.length && !settings.ENRICHMENT_SIGNING_SECRET)
    throw new Error('Configured enrichment requires a GotIt signing secret');
  return {
    registry: new EnrichmentRegistry(providers, profiles, routes),
    proofs: new SelectionProofs(settings.ENRICHMENT_SIGNING_SECRET),
  };
}
