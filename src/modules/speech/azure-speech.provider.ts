import { z } from 'zod';
import type { SpeechProvider } from './speech.service.js';

const languageConfigSchema = z
  .record(
    z.string().min(2).max(35),
    z
      .object({
        locale: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z]{2,8})+$/u),
        voice: z.string().regex(/^[A-Za-z0-9:-]{3,100}$/u),
      })
      .strict(),
  )
  .refine((value) => Object.keys(value).length > 0, 'At least one speech language is required');

const assessmentSchema = z
  .object({
    RecognitionStatus: z.string(),
    NBest: z
      .array(
        z
          .object({
            AccuracyScore: z.number().min(0).max(100),
            FluencyScore: z.number().min(0).max(100).optional(),
            CompletenessScore: z.number().min(0).max(100).optional(),
            PronScore: z.number().min(0).max(100),
            Words: z
              .array(
                z
                  .object({
                    Word: z.string().max(200),
                    AccuracyScore: z.number().min(0).max(100),
                    ErrorType: z.string().max(100).optional(),
                  })
                  .passthrough(),
              )
              .max(100)
              .optional(),
          })
          .passthrough(),
      )
      .min(1)
      .max(10),
  })
  .passthrough();

const pronunciationLocales = new Set([
  'ar-EG',
  'ar-SA',
  'ca-ES',
  'zh-HK',
  'zh-CN',
  'zh-TW',
  'da-DK',
  'nl-NL',
  'en-AU',
  'en-CA',
  'en-IN',
  'en-GB',
  'en-US',
  'fi-FI',
  'fr-CA',
  'fr-FR',
  'de-DE',
  'hi-IN',
  'it-IT',
  'ja-JP',
  'ko-KR',
  'ms-MY',
  'nb-NO',
  'pl-PL',
  'pt-BR',
  'pt-PT',
  'ru-RU',
  'es-MX',
  'es-ES',
  'sv-SE',
  'ta-IN',
  'th-TH',
  'vi-VN',
]);

type LanguageConfig = z.infer<typeof languageConfigSchema>;

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function boundedBuffer(response: Response, maximum: number) {
  if (!response.ok || !response.body) throw new Error('Azure Speech request failed');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new Error('Azure Speech response is too large');
      chunks.push(next.value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function feedback(result: z.infer<typeof assessmentSchema>['NBest'][number]) {
  const dimensions = [`דיוק ${Math.round(result.AccuracyScore)}`];
  if (result.FluencyScore !== undefined) dimensions.push(`שטף ${Math.round(result.FluencyScore)}`);
  if (result.CompletenessScore !== undefined)
    dimensions.push(`שלמות ${Math.round(result.CompletenessScore)}`);
  const weak = (result.Words ?? [])
    .filter((word) => word.AccuracyScore < 80 || (word.ErrorType && word.ErrorType !== 'None'))
    .slice(0, 3)
    .map((word) => `${word.Word} (${Math.round(word.AccuracyScore)})`);
  return `${dimensions.join(' · ')}${weak.length ? `. כדאי לתרגל: ${weak.join(', ')}.` : '. הגייה טובה.'}`;
}

export class AzureSpeechProvider implements SpeechProvider {
  readonly id = 'azure_speech';
  private readonly ttsEndpoint: string;
  private readonly sttEndpoint: string;
  private readonly languages: LanguageConfig;

  constructor(
    private readonly key: string,
    region: string,
    languagesJson?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.ttsEndpoint = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
    this.sttEndpoint = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1`;
    this.languages = languageConfigSchema.parse(
      languagesJson
        ? JSON.parse(languagesJson)
        : { en: { locale: 'en-US', voice: 'en-US-JennyNeural' } },
    );
  }

  private language(language: string) {
    return this.languages[language] ?? this.languages[language.toLowerCase()];
  }

  supports(language: string, operation: 'listening' | 'pronunciation') {
    const config = this.language(language);
    return Boolean(
      config && (operation === 'listening' || pronunciationLocales.has(config.locale)),
    );
  }

  async synthesize(text: string, language: string, signal: AbortSignal) {
    const config = this.language(language);
    if (!config) throw new Error('Unsupported speech language');
    const response = await this.fetcher(this.ttsEndpoint, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'GotIt',
      },
      body: `<speak version="1.0" xml:lang="${escapeXml(config.locale)}"><voice name="${escapeXml(config.voice)}">${escapeXml(text)}</voice></speak>`,
      signal,
    });
    return {
      audio: await boundedBuffer(response, 1_000_000),
      contentType: 'audio/mpeg' as const,
    };
  }

  async assess(
    input: { audio: Buffer; text: string; language: string; idempotencyKey: string },
    signal: AbortSignal,
  ) {
    const config = this.language(input.language);
    if (!config || !pronunciationLocales.has(config.locale))
      throw new Error('Unsupported pronunciation language');
    const parameters = Buffer.from(
      JSON.stringify({
        ReferenceText: input.text,
        GradingSystem: 'HundredMark',
        Granularity: 'Word',
        Dimension: 'Comprehensive',
        EnableMiscue: 'True',
      }),
    ).toString('base64');
    const url = new URL(this.sttEndpoint);
    url.searchParams.set('language', config.locale);
    url.searchParams.set('format', 'detailed');
    const response = await this.fetcher(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.key,
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
        Accept: 'application/json',
        'Pronunciation-Assessment': parameters,
      },
      body: Uint8Array.from(input.audio),
      signal,
    });
    const raw = await boundedBuffer(response, 131_072);
    const parsed = assessmentSchema.parse(JSON.parse(raw.toString('utf8')));
    if (parsed.RecognitionStatus !== 'Success') throw new Error('Speech was not recognized');
    const result = parsed.NBest[0]!;
    return {
      score: result.PronScore,
      feedback: feedback(result),
      model: `azure-pronunciation-${config.locale}`,
    };
  }
}
