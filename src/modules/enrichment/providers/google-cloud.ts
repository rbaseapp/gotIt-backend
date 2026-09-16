import { z } from 'zod';
import type { EnrichmentProvider, EnrichmentInput, ModelProfile } from '../enrichment.types.js';
import { languageSchema } from '../../capture/capture.validation.js';
import { readProviderJson } from './http.js';
const responseSchema = z
  .object({
    data: z
      .object({
        translations: z
          .array(
            z
              .object({
                translatedText: z.string().max(8000),
                detectedSourceLanguage: z.string().max(64).optional(),
                model: z.string().max(200).optional(),
              })
              .passthrough(),
          )
          .length(1),
      })
      .passthrough(),
  })
  .passthrough();

/** Google Cloud Translation Basic v2; language mappings are explicit, never inferred. */
export class GoogleCloudTranslationProvider implements EnrichmentProvider {
  readonly id = 'google_cloud_translation';
  readonly kind = 'translation_api' as const;
  readonly capabilities = {
    detection: true,
    context: false,
    phonetics: false,
    examples: false,
    models: false,
  };
  constructor(
    private readonly apiKey: string,
    private readonly languages: Record<string, string> = {},
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!apiKey) throw new Error('Google translation key is required');
  }
  async enrich(input: EnrichmentInput, _profile: ModelProfile, signal: AbortSignal) {
    const response = await this.fetchImpl(
      'https://translation.googleapis.com/language/translate/v2',
      {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', 'X-Goog-Api-Key': this.apiKey },
        body: JSON.stringify({
          q: [input.sourceText],
          target: this.languages[input.translationLanguageCode] ?? input.translationLanguageCode,
          format: 'text',
          ...(input.sourceLanguageCode
            ? { source: this.languages[input.sourceLanguageCode] ?? input.sourceLanguageCode }
            : {}),
        }),
      },
    );
    const translation = responseSchema.parse(await readProviderJson(response, signal)).data
      .translations[0]!;
    const sourceLanguageCode =
      input.sourceLanguageCode ?? languageSchema.parse(translation.detectedSourceLanguage);
    // Basic translates plain text yet escapes HTML entities in its response.
    const text = translation.translatedText.replace(
      /&(#(?:x[0-9a-f]+|[0-9]+)|amp|lt|gt|quot|apos);/giu,
      (_match, entity: string) => {
        const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
        if (entity[0] !== '#') return named[entity.toLowerCase()]!;
        const point =
          entity[1]?.toLowerCase() === 'x'
            ? parseInt(entity.slice(2), 16)
            : parseInt(entity.slice(1), 10);
        return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
          ? String.fromCodePoint(point)
          : _match;
      },
    );
    return {
      sourceLanguageCode,
      candidates: [{ text, variants: [], partOfSpeech: null, examples: [], contextUsed: false }],
    };
  }
}
