import { z } from 'zod';
import { AppError } from '../../shared/errors/app-error.js';
import type { SpeechProvider } from './speech.service.js';

const languageConfigSchema = z
  .record(
    z.string().min(2).max(35),
    z
      .object({
        locale: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z]{2,8})+$/u),
        voice: z.string().min(3).max(100).optional(),
        recognitionLocale: z
          .string()
          .regex(/^[a-z]{2,3}(?:-[A-Za-z]{2,8})+$/u)
          .optional(),
        recognitionModel: z.string().min(3).max(100).optional(),
      })
      .strict(),
  )
  .refine((value) => Object.keys(value).length > 0, 'At least one speech language is required')
  .superRefine((value, ctx) => {
    for (const [sourceLanguage, config] of Object.entries(value)) {
      try {
        const sourceBase = new Intl.Locale(sourceLanguage).language;
        const recognitionBase = new Intl.Locale(config.recognitionLocale ?? config.locale).language;
        if (sourceBase !== recognitionBase)
          ctx.addIssue({
            code: 'custom',
            path: [sourceLanguage, 'recognitionLocale'],
            message: 'Recognition locale must match the configured source language',
          });
      } catch {
        ctx.addIssue({
          code: 'custom',
          path: [sourceLanguage],
          message: 'Speech language key must be a valid BCP-47 language code',
        });
      }
    }
  });

const synthesisSchema = z
  .object({
    audioContent: z.string().min(1).max(1_333_336),
  })
  .strict();

const recognitionSchema = z
  .object({
    results: z
      .array(
        z
          .object({
            alternatives: z
              .array(
                z
                  .object({
                    transcript: z.string().max(4000),
                    confidence: z.number().min(0).max(1).optional(),
                    words: z
                      .array(
                        z
                          .object({
                            word: z.string().max(200),
                            confidence: z.number().min(0).max(1).optional(),
                          })
                          .passthrough(),
                      )
                      .max(100)
                      .optional(),
                  })
                  .passthrough(),
              )
              .max(30),
            languageCode: z.string().max(64).optional(),
          })
          .passthrough(),
      )
      .max(30)
      .default([]),
  })
  .passthrough();

type LanguageConfig = z.infer<typeof languageConfigSchema>;

async function boundedJson(response: Response, maximum: number, signal: AbortSignal) {
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if ([401, 403].includes(response.status))
      throw new AppError(
        503,
        'SPEECH_AUTH_FAILED',
        'Speech provider credentials are invalid or lack permission',
      );
    if (response.status === 400)
      throw new AppError(
        503,
        'SPEECH_REQUEST_REJECTED',
        'Speech provider rejected the audio or language configuration',
      );
    if (response.status === 429)
      throw new AppError(503, 'SPEECH_QUOTA_EXCEEDED', 'Speech provider quota was exceeded');
    throw new Error('Google Speech request failed');
  }
  if (!response.body) throw new Error('Google Speech response has no body');
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => {});
  signal.addEventListener('abort', cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new Error('Google Speech response is too large');
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function normalize(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .replace(/\s+/gu, ' ');
}

function editSimilarity(actual: string, expected: string) {
  const left = [...normalize(actual)];
  const right = [...normalize(expected)];
  if (!right.length) return 0;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++)
      current[j] = Math.min(
        current[j - 1]! + 1,
        previous[j]! + 1,
        previous[j - 1]! + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    previous.splice(0, previous.length, ...current);
  }
  return Math.max(0, 1 - previous[right.length]! / Math.max(left.length, right.length));
}

function assessment(transcript: string, expected: string, confidence: number | undefined) {
  if (!transcript.trim())
    return {
      score: 0,
      feedback: 'לא הצלחנו לזהות את המילה. נסו שוב לאט יותר ובסביבה שקטה.',
    };
  const similarity = editSimilarity(transcript, expected);
  const score = Math.round(Math.min(100, Math.max(0, similarity * 85 + (confidence ?? 0) * 15)));
  const feedback = `זוהה: “${transcript}” · התאמה ${Math.round(similarity * 100)} · ${confidence === undefined ? 'ביטחון זיהוי לא סופק' : `ביטחון זיהוי ${Math.round(confidence * 100)}`}.`;
  return { score, feedback };
}

function sameBaseLanguage(left: string, right: string) {
  try {
    return new Intl.Locale(left).language === new Intl.Locale(right).language;
  } catch {
    return false;
  }
}

export class GoogleSpeechProvider implements SpeechProvider {
  readonly id = 'google_speech';
  private readonly languages: LanguageConfig;

  constructor(
    private readonly apiKey: string,
    languagesJson?: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly accessToken?: () => Promise<string>,
  ) {
    this.languages = languageConfigSchema.parse(
      languagesJson
        ? JSON.parse(languagesJson)
        : {
            en: {
              locale: 'en-US',
              voice: 'en-US-Standard-C',
              recognitionLocale: 'en-US',
              recognitionModel: 'latest_short',
            },
            he: {
              locale: 'he-IL',
              voice: 'he-IL-Standard-A',
              recognitionLocale: 'iw-IL',
              recognitionModel: 'command_and_search',
            },
          },
    );
  }

  private language(language: string) {
    const normalized = language.toLowerCase();
    return (
      this.languages[language] ??
      this.languages[normalized] ??
      this.languages[normalized.split('-')[0]!]
    );
  }

  supports(language: string, operation: 'listening' | 'pronunciation') {
    return (
      Boolean(this.language(language)) && (operation === 'listening' || Boolean(this.accessToken))
    );
  }

  async synthesize(text: string, language: string, signal: AbortSignal) {
    const config = this.language(language);
    if (!config) throw new Error('Unsupported speech language');
    const response = await this.fetcher('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: {
        'X-Goog-Api-Key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: config.locale, ...(config.voice ? { name: config.voice } : {}) },
        audioConfig: { audioEncoding: 'MP3' },
      }),
      signal,
    });
    const parsed = synthesisSchema.parse(await boundedJson(response, 1_400_000, signal));
    const audio = Buffer.from(parsed.audioContent, 'base64');
    if (!audio.length || audio.length > 1_000_000)
      throw new Error('Invalid Google Speech audio response');
    return { audio, contentType: 'audio/mpeg' as const };
  }

  async assess(
    input: { audio: Buffer; text: string; language: string; idempotencyKey: string },
    signal: AbortSignal,
  ) {
    const config = this.language(input.language);
    if (!config || !this.accessToken) throw new Error('Unsupported pronunciation language');
    let token: string;
    try {
      token = await this.accessToken();
    } catch {
      throw new AppError(
        503,
        'SPEECH_AUTH_FAILED',
        'Speech provider credentials are invalid or unavailable',
      );
    }
    const response = await this.fetcher('https://speech.googleapis.com/v1/speech:recognize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        config: {
          encoding: 'LINEAR16',
          sampleRateHertz: 16000,
          audioChannelCount: 1,
          languageCode: config.recognitionLocale ?? config.locale,
          // An empty alternative list keeps recognition pinned to the learning item's
          // source language instead of asking Google to auto-select another language.
          alternativeLanguageCodes: [],
          model: config.recognitionModel ?? 'command_and_search',
          enableWordConfidence: true,
          // Pronunciation exercises always have a trusted expected expression. Supplying
          // it as context improves recognition of short isolated words without changing
          // the language selected above.
          speechContexts: [{ phrases: [input.text], boost: 15 }],
        },
        audio: { content: input.audio.toString('base64') },
      }),
      signal,
    });
    const parsed = recognitionSchema.parse(await boundedJson(response, 262_144, signal));
    const recognitionLanguage = config.recognitionLocale ?? config.locale;
    const best = parsed.results.find(
      (candidate) =>
        !candidate.languageCode || sameBaseLanguage(candidate.languageCode, recognitionLanguage),
    )?.alternatives[0];
    const result = assessment(best?.transcript ?? '', input.text, best?.confidence);
    return {
      ...result,
      model: `google-stt-confidence-v1:${config.recognitionLocale ?? config.locale}`,
    };
  }
}

export const googleSpeechAssessment = assessment;
