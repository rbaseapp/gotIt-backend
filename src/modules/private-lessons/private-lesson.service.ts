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
import {
  buildPrivateLessonPrompt,
  describeLessonLanguage,
  type PrivateLessonPlan,
} from './private-lesson.prompt.js';
import {
  privateLessonNotFound,
  type PrivateLessonJournal,
  type StoredPrivateLesson,
} from './private-lesson.repository.js';
import {
  basicPrivateLessonReport,
  type PrivateLessonSummaryGenerator,
} from './private-lesson.summary.js';
import type {
  PrivateLessonCompletionInput,
  PrivateLessonInput,
} from './private-lesson.validation.js';

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

const voiceByGender = {
  female: 'marin',
  male: 'cedar',
} as const;

const speedByRate = {
  slow: 0.85,
  normal: 1,
  fast: 1.2,
} as const;

export interface PrivateLessonVocabularySource {
  learned(
    scope: ProfileScope,
    targetLanguageCode: string,
    count?: number,
  ): Promise<{ items: QueueItem[] }>;
}

export type PrivateLessonServiceOptions = {
  apiKey?: string;
  model: string;
  voice: string;
  transcriptionModel: string;
  profiles: ProfileServiceContract;
  vocabulary: PrivateLessonVocabularySource;
  fetchImpl?: typeof fetch;
  journal?: PrivateLessonJournal;
  summaryGenerator?: PrivateLessonSummaryGenerator;
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

    const [profile, previousLessons] = await Promise.all([
      this.options.profiles.getProfile(scope),
      this.options.journal?.list(scope, 20) ?? Promise.resolve([]),
    ]);
    const targetBaseLanguage = new Intl.Locale(input.targetLanguageCode).language;
    const previousLesson =
      previousLessons.find(
        (lesson) =>
          lesson.status === 'completed' &&
          lesson.report &&
          new Intl.Locale(lesson.targetLanguageCode).language === targetBaseLanguage,
      ) ?? null;
    const vocabularyMode = input.vocabularyMode ?? previousLesson?.vocabularyMode ?? 'learned';
    const vocabulary =
      vocabularyMode === 'learned'
        ? await this.options.vocabulary.learned(scope, input.targetLanguageCode, 20)
        : { items: [] };
    const plan = this.buildPlan(input, profile, vocabulary.items, previousLesson, vocabularyMode);
    const instructions = buildPrivateLessonPrompt(plan);
    const targetLanguage = describeLessonLanguage(plan.targetLanguageCode);
    const supportLanguage = plan.supportLanguageCode
      ? describeLessonLanguage(plan.supportLanguageCode)
      : null;
    const voice = input.teacherVoice ? voiceByGender[input.teacherVoice] : this.options.voice;
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
              output: { voice, speed: speedByRate[plan.speechRate] },
            },
          },
        }),
        signal: controller.signal,
      });
      const secret = clientSecretSchema.parse(await readProviderJson(response, controller.signal));

      await this.options.journal?.create(scope, plan);
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
              instructions: `Begin the lesson now. Speak only in ${targetLanguage.promptName}. The very first spoken word must be in this language. Give a brief greeting, then follow the lesson flow in the session instructions, including the short previous-lesson review when continuity data is present. Ask only one short question. Do not use any other language.`,
            },
          },
          wrapUpEvent: {
            type: 'response.create',
            response: {
              instructions: `The lesson is ending now. Speak only in ${targetLanguage.promptName}. Do not ask another question. In three short parts, give one specific success, one correction with the correct form, and the target words worth reviewing. Then say a warm, encouraging goodbye in the same language. Do not use any other language. Keep the entire closing under 20 seconds.`,
            },
          },
          translationEvent: supportLanguage
            ? {
                type: 'response.create',
                response: {
                  instructions: `For this response only, translate the most recent tutor sentence into ${supportLanguage.promptName}. Give only the translation and at most one brief clarification. Do not advance the lesson or ask a new question. After this response, resume speaking only in ${targetLanguage.promptName}.`,
                },
              }
            : null,
        },
      };
    } catch (error) {
      throw privateLessonProviderError(error, controller.signal.aborted);
    } finally {
      clearTimeout(timeout);
    }
  }

  async completeSession(scope: ProfileScope, id: string, input: PrivateLessonCompletionInput) {
    const journal = this.requireJournal();
    const existing = await journal.get(scope, id);
    if (!existing) throw privateLessonNotFound();
    if (existing.status === 'completed' && existing.report) return publicStoredLesson(existing);

    const claimed = await journal.claim(scope, id, input.actualDurationSeconds);
    if (!claimed) {
      const current = await journal.get(scope, id);
      if (current?.status === 'completed' && current.report) return publicStoredLesson(current);
      if (!current) throw privateLessonNotFound();
      throw new AppError(
        409,
        'PRIVATE_LESSON_REPORT_IN_PROGRESS',
        'The lesson report is already being generated',
      );
    }

    try {
      const report = this.options.summaryGenerator
        ? await this.options.summaryGenerator.generate(
            claimed,
            input.turns,
            safetyIdentifier(scope),
          )
        : basicPrivateLessonReport(claimed);
      const completed = await journal.complete(scope, id, report);
      await this.options.profiles
        .recordSystemAssessment?.(scope, {
          languageCode: claimed.targetLanguageCode,
          level: report.assessment.overallLevel,
          confidence: { low: 0.35, medium: 0.7, high: 0.9 }[report.assessment.confidence],
        })
        .catch(() => undefined);
      return publicStoredLesson(completed);
    } catch {
      await journal.fail(scope, id);
      throw new AppError(
        503,
        'PRIVATE_LESSON_REPORT_FAILED',
        'The lesson ended, but its report could not be generated yet',
      );
    }
  }

  async listSessions(scope: ProfileScope, limit: number) {
    return { lessons: (await this.requireJournal().list(scope, limit)).map(publicStoredLesson) };
  }

  async getSession(scope: ProfileScope, id: string) {
    const lesson = await this.requireJournal().get(scope, id);
    if (!lesson) throw privateLessonNotFound();
    return publicStoredLesson(lesson);
  }

  async removeSession(scope: ProfileScope, id: string) {
    if (!(await this.requireJournal().remove(scope, id))) throw privateLessonNotFound();
    return { deleted: true };
  }

  private requireJournal() {
    if (!this.options.journal)
      throw new AppError(
        503,
        'PRIVATE_LESSON_JOURNAL_NOT_CONFIGURED',
        'Private lesson history is unavailable',
      );
    return this.options.journal;
  }

  private buildPlan(
    input: PrivateLessonInput,
    profile: GotItProfile,
    queue: QueueItem[],
    previousLesson: StoredPrivateLesson | null,
    vocabularyMode: PrivateLessonPlan['vocabularyMode'],
  ) {
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
      input.supportLanguageCode === undefined
        ? profileSupportLanguage &&
          new Intl.Locale(profileSupportLanguage).language !==
            new Intl.Locale(input.targetLanguageCode).language
          ? profileSupportLanguage
          : null
        : input.supportLanguageCode;
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
    const focusAreas = [
      ...new Set([
        ...(input.focusAreas ?? previousLesson?.focusAreas ?? ['speaking', 'vocabulary']),
        ...(input.grammarFocus ? (['grammar'] as const) : []),
      ]),
    ];
    const previousReport = previousLesson?.status === 'completed' ? previousLesson.report : null;
    const continuity =
      previousLesson && previousReport
        ? {
            previousLessonId: previousLesson.id,
            previousSummary: previousReport.summary,
            nextLessonPlan: previousReport.nextLessonPlan,
            correctionsToRevisit: previousReport.corrections
              .slice(0, 3)
              .map((item) => `${item.original} -> ${item.corrected}`),
            vocabularyToReview: previousReport.vocabulary
              .filter((item) => item.outcome !== 'practiced')
              .slice(0, 5)
              .map((item) => item.sourceText),
          }
        : null;

    return {
      id: randomUUID(),
      durationSeconds: input.requestedDurationMinutes
        ? input.requestedDurationMinutes * 60
        : this.durationSeconds,
      targetLanguageCode: input.targetLanguageCode,
      supportLanguageCode,
      level,
      topic: input.topic ?? profile.interests[0] ?? 'everyday conversation',
      grammarFocus: input.grammarFocus ?? null,
      focusAreas,
      customFocus:
        input.customFocus === undefined ? (previousLesson?.customFocus ?? null) : input.customFocus,
      correctionMode: input.correctionMode ?? previousLesson?.correctionMode ?? 'recast',
      vocabularyMode,
      teacherVoice: input.teacherVoice ?? 'female',
      speechRate: input.speechRate ?? 'normal',
      interests: profile.interests.slice(0, 10),
      targets,
      continuity,
    } satisfies PrivateLessonPlan;
  }
}

function publicStoredLesson(lesson: StoredPrivateLesson) {
  return {
    id: lesson.id,
    targetLanguageCode: lesson.targetLanguageCode,
    supportLanguageCode: lesson.supportLanguageCode,
    level: lesson.level,
    topic: lesson.topic,
    grammarFocus: lesson.grammarFocus,
    focusAreas: lesson.focusAreas,
    customFocus: lesson.customFocus,
    correctionMode: lesson.correctionMode,
    vocabularyMode: lesson.vocabularyMode,
    continuesFromLessonId: lesson.continuity?.previousLessonId ?? null,
    teacherVoice: lesson.teacherVoice,
    speechRate: lesson.speechRate,
    plannedDurationSeconds: lesson.durationSeconds,
    actualDurationSeconds: lesson.actualDurationSeconds,
    targetWords: lesson.targets,
    status: lesson.status,
    startedAt: lesson.startedAt,
    endedAt: lesson.endedAt,
    report: lesson.report,
  };
}

function publicPlan(plan: PrivateLessonPlan) {
  const wrapUpLeadSeconds = Math.min(5, Math.max(3, Math.floor(plan.durationSeconds * 0.02)));
  return {
    id: plan.id,
    durationSeconds: plan.durationSeconds,
    wrapUpAfterSeconds: Math.max(0, plan.durationSeconds - wrapUpLeadSeconds),
    targetLanguageCode: plan.targetLanguageCode,
    supportLanguageCode: plan.supportLanguageCode,
    level: plan.level,
    topic: plan.topic,
    grammarFocus: plan.grammarFocus,
    focusAreas: plan.focusAreas,
    customFocus: plan.customFocus,
    correctionMode: plan.correctionMode,
    vocabularyMode: plan.vocabularyMode,
    continuesFromLessonId: plan.continuity?.previousLessonId ?? null,
    teacherVoice: plan.teacherVoice,
    speechRate: plan.speechRate,
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
