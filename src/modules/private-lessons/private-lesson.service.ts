import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../shared/errors/app-error.js';
import {
  ProviderHttpError,
  providerFailureCode,
  readProviderJson,
} from '../enrichment/providers/http.js';
import type {
  CefrLevel,
  GotItProfile,
  ProfileScope,
  ProfileServiceContract,
} from '../profile/profile.types.js';
import { buildPrivateLessonPrompt, type PrivateLessonPlan } from './private-lesson.prompt.js';
import type { PrivateLessonInput } from './private-lesson.validation.js';

const clientSecretSchema = z
  .object({
    value: z.string().min(1).max(4096),
    expires_at: z.number().int().positive().optional(),
  })
  .passthrough();

type QueueItem = {
  id: string;
  sourceText: string;
  sourceLanguageCode: string;
  primaryTranslation: string;
};

export interface PrivateLessonVocabularySource {
  queue(scope: ProfileScope, count?: number): Promise<{ items: QueueItem[] }>;
}

export type PrivateLessonServiceOptions = {
  apiKey?: string;
  model: string;
  voice: string;
  transcriptionModel: string;
  profiles: ProfileServiceContract;
  vocabulary: PrivateLessonVocabularySource;
  fetchImpl?: typeof fetch;
  durationSeconds?: number;
  requestTimeoutMs?: number;
};

export class PrivateLessonService {
  readonly durationSeconds: number;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: PrivateLessonServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.durationSeconds = options.durationSeconds ?? 300;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
  }

  get available() {
    return Boolean(this.options.apiKey);
  }

  async createSession(scope: ProfileScope, input: PrivateLessonInput) {
    if (!this.options.apiKey)
      throw new AppError(
        503,
        'PRIVATE_LESSON_NOT_CONFIGURED',
        'Private voice lessons are unavailable',
      );

    const [profile, queue] = await Promise.all([
      this.options.profiles.getProfile(scope),
      this.options.vocabulary.queue(scope, 20),
    ]);
    const plan = this.buildPlan(input, profile, queue.items);
    const instructions = buildPrivateLessonPrompt(plan);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await this.fetchImpl('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          'openai-safety-identifier': safetyIdentifier(scope),
        },
        body: JSON.stringify({
          session: {
            type: 'realtime',
            model: this.options.model,
            output_modalities: ['audio'],
            instructions,
            audio: {
              input: {
                transcription: { model: this.options.transcriptionModel },
                turn_detection: {
                  type: 'semantic_vad',
                  eagerness: 'medium',
                  create_response: true,
                  interrupt_response: true,
                },
              },
              output: { voice: this.options.voice },
            },
          },
        }),
        signal: controller.signal,
      });
      const secret = clientSecretSchema.parse(await readProviderJson(response, controller.signal));

      return {
        lesson: publicPlan(plan),
        realtime: {
          clientSecret: secret.value,
          expiresAt:
            secret.expires_at === undefined
              ? null
              : new Date(secret.expires_at * 1000).toISOString(),
          model: this.options.model,
          connectionUrl: 'https://api.openai.com/v1/realtime/calls',
          openingEvent: {
            type: 'response.create',
            response: {
              instructions:
                'Begin the lesson now with a brief greeting in the target language and one easy question about the lesson topic.',
            },
          },
          wrapUpEvent: {
            type: 'response.create',
            response: {
              instructions:
                'The lesson is ending. Give the promised concise recap now, then say goodbye in the target language.',
            },
          },
        },
      };
    } catch (error) {
      throw privateLessonProviderError(error, controller.signal.aborted);
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildPlan(input: PrivateLessonInput, profile: GotItProfile, queue: QueueItem[]) {
    const languageProfile = profile.languages.find(
      (language) =>
        new Intl.Locale(language.languageCode).language ===
        new Intl.Locale(input.targetLanguageCode).language,
    );
    const level =
      input.requestedLevel ??
      languageProfile?.effectiveLevel ??
      languageProfile?.selfAssessedLevel ??
      ('A2' satisfies CefrLevel);
    const profileSupportLanguage = profile.defaultTranslationLanguage;
    const supportLanguageCode =
      input.supportLanguageCode ??
      (profileSupportLanguage &&
      new Intl.Locale(profileSupportLanguage).language !==
        new Intl.Locale(input.targetLanguageCode).language
        ? profileSupportLanguage
        : null);
    const targets = queue
      .filter(
        (item) =>
          new Intl.Locale(item.sourceLanguageCode).language ===
          new Intl.Locale(input.targetLanguageCode).language,
      )
      .slice(0, 5)
      .map((item) => ({
        learningItemId: item.id,
        sourceText: item.sourceText,
        translationText: item.primaryTranslation,
      }));

    return {
      id: randomUUID(),
      durationSeconds: this.durationSeconds,
      targetLanguageCode: input.targetLanguageCode,
      supportLanguageCode,
      level,
      topic: input.topic ?? profile.interests[0] ?? 'everyday conversation',
      grammarFocus: input.grammarFocus ?? null,
      interests: profile.interests.slice(0, 10),
      targets,
    } satisfies PrivateLessonPlan;
  }
}

function publicPlan(plan: PrivateLessonPlan) {
  return {
    id: plan.id,
    durationSeconds: plan.durationSeconds,
    wrapUpAfterSeconds: Math.max(0, plan.durationSeconds - 45),
    targetLanguageCode: plan.targetLanguageCode,
    supportLanguageCode: plan.supportLanguageCode,
    level: plan.level,
    topic: plan.topic,
    grammarFocus: plan.grammarFocus,
    targetWords: plan.targets,
  };
}

function safetyIdentifier(scope: ProfileScope) {
  return createHash('sha256')
    .update(`gotit-private-lesson:${scope.applicationId}:${scope.applicationUserId}`)
    .digest('hex');
}

function privateLessonProviderError(error: unknown, timedOut: boolean) {
  if (error instanceof AppError) return error;
  const failure = timedOut ? 'timeout' : providerFailureCode(error);
  if (failure === 'authentication')
    return new AppError(
      503,
      'PRIVATE_LESSON_PROVIDER_AUTHENTICATION',
      'The voice provider rejected the configured API key',
    );
  if (failure === 'billing')
    return new AppError(
      503,
      'PRIVATE_LESSON_PROVIDER_BILLING',
      'The voice provider account requires billing attention',
    );
  if (failure === 'permission' || failure === 'model_access')
    return new AppError(
      503,
      'PRIVATE_LESSON_PROVIDER_PERMISSION',
      'The configured API key cannot access the voice model',
    );
  if (failure === 'rate_limit')
    return new AppError(
      503,
      'PRIVATE_LESSON_PROVIDER_RATE_LIMIT',
      'The voice provider rate limit was reached',
    );
  if (failure === 'invalid_request')
    return new AppError(
      503,
      'PRIVATE_LESSON_PROVIDER_REQUEST_INVALID',
      'The voice provider rejected the session configuration',
    );
  if (failure === 'timeout')
    return new AppError(
      503,
      'PRIVATE_LESSON_PROVIDER_TIMEOUT',
      'The voice provider did not create a session in time',
    );
  if (error instanceof z.ZodError || error instanceof SyntaxError)
    return new AppError(
      503,
      'PRIVATE_LESSON_PROVIDER_RESPONSE_INVALID',
      'The voice provider returned an invalid session response',
    );
  if (error instanceof ProviderHttpError)
    return new AppError(
      503,
      'PRIVATE_LESSON_PROVIDER_UPSTREAM',
      'The voice provider is temporarily unavailable',
    );
  return new AppError(
    503,
    'PRIVATE_LESSON_PROVIDER_UPSTREAM',
    'The voice session could not be created',
  );
}
