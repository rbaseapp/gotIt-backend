import { createHash, randomUUID } from 'node:crypto';
import { privateLessonTeachers } from './private-lesson.teachers.js';
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
  type PrivateLessonReportFailureCode,
  type StoredPrivateLesson,
} from './private-lesson.repository.js';
import {
  basicPrivateLessonReport,
  PrivateLessonSummaryError,
  type PrivateLessonSummaryGenerator,
} from './private-lesson.summary.js';
import type {
  PrivateLessonCompletionInput,
  PrivateLessonInput,
  PrivateLessonPreferencesInput,
} from './private-lesson.validation.js';
import type { PrivateLessonRoadmapStore } from './private-lesson.roadmap.js';
import { setupPayload } from './private-lesson.roadmap.js';
import type { PrivateLessonProficiencyStore } from './private-lesson.proficiency.js';
import type { PrivateLessonGoalKind } from './private-lesson.curriculum.js';
import type { CourseService } from '../courses/course.service.js';
import type { CourseGenerator } from '../courses/course.provider.js';
import {
  privateLessonBriefInput,
  privateLessonBriefInstruction,
  privateLessonBriefSchema,
} from './private-lesson.content.js';

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

const speedByRate = {
  very_slow: 0.7,
  slow: 0.85,
  normal: 1,
  fast: 1.2,
  very_fast: 1.4,
} as const;

export interface PrivateLessonVocabularySource {
  learned(
    scope: ProfileScope,
    targetLanguageCode: string,
    count?: number,
  ): Promise<{ items: QueueItem[] }>;
}

export type PrivateLessonServiceOptions = {
  courses?: CourseService;
  lessonContentGenerator?: Pick<CourseGenerator, 'generate'>;
  apiKey?: string;
  model: string;
  voice: string;
  transcriptionModel: string;
  profiles: ProfileServiceContract;
  vocabulary: PrivateLessonVocabularySource;
  fetchImpl?: typeof fetch;
  journal?: PrivateLessonJournal;
  summaryGenerator?: PrivateLessonSummaryGenerator;
  roadmaps?: PrivateLessonRoadmapStore;
  proficiency?: PrivateLessonProficiencyStore;
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

  async savePreferences(scope: ProfileScope, input: PrivateLessonPreferencesInput) {
    if (!this.options.roadmaps)
      throw new AppError(
        503,
        'PRIVATE_LESSON_PREFERENCES_NOT_CONFIGURED',
        'Private lesson preferences are unavailable',
      );
    await this.options.roadmaps.savePreferenceValues(scope, input);
    return {
      preferences: await this.options.roadmaps.getPreferences(scope, input.targetLanguageCode),
    };
  }

  async createSession(scope: ProfileScope, input: PrivateLessonInput) {
    if (!this.options.apiKey)
      throw new AppError(
        503,
        'PRIVATE_LESSON_NOT_CONFIGURED',
        'Private voice lessons are unavailable',
      );

    if (input.courseId && !this.options.courses)
      throw new AppError(503, 'COURSE_AI_UNAVAILABLE', 'Courses are unavailable');
    const courseContext = input.courseId
      ? await this.options.courses!.lessonContext(scope, input.courseId)
      : null;
    if (courseContext)
      input = {
        ...input,
        targetLanguageCode: courseContext.preferences.targetLanguageCode,
        supportLanguageCode: courseContext.preferences.supportLanguageCode,
        requestedLevel: courseContext.level,
        requestedDurationMinutes: courseContext.preferences.minutesPerLesson,
        lessonMode:
          courseContext.preferences.absoluteBeginner && courseContext.level === 'A1'
            ? 'absolute_beginner'
            : 'standard',
        vocabularyMode: 'none',
        customFocus: null,
      };
    const [profile, previousLessons, preferences, loadedRoadmap] = await Promise.all([
      this.options.profiles.getProfile(scope),
      this.options.journal?.list(scope, 20) ?? Promise.resolve([]),
      this.options.roadmaps?.getPreferences(scope, input.targetLanguageCode) ??
        Promise.resolve(null),
      this.options.roadmaps?.getActive(scope, input.targetLanguageCode) ?? Promise.resolve(null),
    ]);
    const requestedLessonMode = input.lessonMode ?? preferences?.lessonMode ?? 'standard';
    const configuredSupportLanguage =
      input.supportLanguageCode === undefined && preferences
        ? preferences.supportLanguageCode
        : input.supportLanguageCode === undefined
          ? profile.defaultTranslationLanguage
          : input.supportLanguageCode;
    if (
      requestedLessonMode === 'absolute_beginner' &&
      (!configuredSupportLanguage ||
        new Intl.Locale(configuredSupportLanguage).language ===
          new Intl.Locale(input.targetLanguageCode).language)
    )
      throw new AppError(
        400,
        'PRIVATE_LESSON_SUPPORT_LANGUAGE_REQUIRED',
        'Absolute beginner lessons require a support language that differs from the target language',
      );
    const targetBaseLanguage = new Intl.Locale(input.targetLanguageCode).language;
    const previousLesson =
      previousLessons.find(
        (lesson) =>
          lesson.status === 'completed' &&
          lesson.report &&
          (!input.courseId || lesson.course?.courseId === input.courseId) &&
          (Boolean(input.courseId) || lesson.lessonMode === requestedLessonMode) &&
          new Intl.Locale(lesson.targetLanguageCode).language === targetBaseLanguage,
      ) ?? null;
    const activeRoadmap =
      loadedRoadmap ??
      (this.options.roadmaps && !input.courseId && targetBaseLanguage === 'en'
        ? await this.options.roadmaps.create(
            scope,
            input.targetLanguageCode,
            'recommended',
            'recommended-foundation',
            requestedLessonMode === 'absolute_beginner'
              ? 'A1'
              : profileLevel(profile, input.targetLanguageCode),
          )
        : null);
    const vocabularyMode =
      input.vocabularyMode ??
      preferences?.vocabularyMode ??
      previousLesson?.vocabularyMode ??
      'learned';
    const vocabulary =
      vocabularyMode === 'learned'
        ? await this.options.vocabulary.learned(scope, input.targetLanguageCode, 20)
        : { items: [] };
    let plan: PrivateLessonPlan = this.buildPlan(
      input,
      profile,
      vocabulary.items,
      previousLesson,
      vocabularyMode,
      preferences,
      activeRoadmap,
    );
    if (input.courseId) {
      if (!this.options.courses)
        throw new AppError(503, 'COURSE_AI_UNAVAILABLE', 'Courses are unavailable');
      plan = await this.options.courses.prepareLesson(scope, plan, input.courseId, courseContext!);
    }
    if (this.options.lessonContentGenerator) {
      const teachingBrief = await this.options.lessonContentGenerator.generate(
        scope,
        privateLessonBriefSchema,
        'private_lesson_brief',
        privateLessonBriefInstruction,
        privateLessonBriefInput(plan),
      );
      plan = { ...plan, teachingBrief };
    }
    const instructions = buildPrivateLessonPrompt(plan);
    // Realtime response instructions replace (rather than append to) session
    // instructions. Preserve the full teaching policy and approved lesson data.
    const responseEvent = (directive: string) => ({
      type: 'response.create' as const,
      response: { instructions: `${instructions}\n\n# Current turn directive\n${directive}` },
    });
    const targetLanguage = describeLessonLanguage(plan.targetLanguageCode);
    const supportLanguage = plan.supportLanguageCode
      ? describeLessonLanguage(plan.supportLanguageCode)
      : null;
    const transcriptionLanguage = new Intl.Locale(targetLanguage.code).language;
    const absoluteBeginner = plan.lessonMode === 'absolute_beginner';
    const bilingualCourse = absoluteBeginner || Boolean(plan.course);
    const teacher = privateLessonTeachers[plan.teacherVoice];
    const voice = teacher.voice;
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
                noise_reduction: { type: 'far_field' },
                transcription: {
                  model: this.options.transcriptionModel,
                  ...(bilingualCourse ? {} : { language: transcriptionLanguage }),
                  prompt:
                    bilingualCourse && supportLanguage
                      ? `The learner may speak ${targetLanguage.englishName} or ${supportLanguage!.englishName}. Transcribe each utterance in the language actually spoken without translating it.`
                      : `The learner is speaking only ${targetLanguage.englishName}. Transcribe the audio as ${targetLanguage.englishName}; do not interpret it as another language.`,
                },
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

      if (!input.courseId) await this.options.roadmaps?.savePreferences(scope, input, plan);
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
          openingEvent: responseEvent(
            absoluteBeginner
              ? `Begin with one short greeting in ${targetLanguage.promptName}, then give its meaning in ${supportLanguage!.promptName}. Introduce yourself as ${teacher.name} and explain today's objective in ${supportLanguage!.promptName}. Follow the approved objective when course is present. Explain the situation, meaning and useful parts of the first target phrase before one simple choice or completion check. Do not start with a repetition drill.`
              : `Begin the lesson now. Speak only in ${targetLanguage.promptName}. The very first spoken word must be in this language. Greet briefly and introduce yourself as ${teacher.name}. State today's objective from the approved course, roadmap or grammar focus. Teach its use and sentence pattern with two clear examples, then ask one recognition or guided-completion check. For an independent unit check, elicit the task without giving its answer. If no structured objective is configured, follow the conversational opening policy. Do not use any other language.`,
          ),
          continuationEvent: responseEvent(
            `Continue the current lesson after a pause or the learner's request to continue. ${absoluteBeginner ? `Use ${supportLanguage!.promptName} for a brief explanation and ${targetLanguage.promptName} for practice.` : `Speak only in ${targetLanguage.promptName}.`} Keep the current objective and conversation history. Do not restart or assume an unheard answer was correct. If the last task is unanswered, give one fresh hint or simpler choice; if it was answered, explain and introduce the next activity. End with one concrete prompt. Do not repeat a mastered sentence or ask the learner to choose what happens next.`,
          ),
          wrapUpEvent: responseEvent(
            absoluteBeginner
              ? `The lesson is ending now. In ${supportLanguage!.promptName}, briefly praise one success and recap the 3-5 ${targetLanguage.promptName} phrases learned today, saying each phrase slowly with its meaning. Do not introduce new material or ask another question. End warmly in ${supportLanguage!.promptName}. Keep the closing under 25 seconds.`
              : `The lesson is ending now. Speak only in ${targetLanguage.promptName}. Do not ask another question. In three short parts, give one specific success, one correction with the correct form, and the target words worth reviewing. Then say a warm, encouraging goodbye in the same language. Do not use any other language. Keep the entire closing under 20 seconds.`,
          ),
          translationEvent: supportLanguage
            ? responseEvent(
                absoluteBeginner
                  ? `In ${supportLanguage.promptName}, explain the meaning of every ${targetLanguage.promptName} phrase from the tutor's most recent turn. Do not introduce new material or ask a new question. Then continue the absolute-beginner lesson using the configured bilingual method.`
                  : `For this response only, translate the tutor's entire most recent speaking turn into ${supportLanguage.promptName}. Translate every sentence from that turn, from beginning to end; do not translate only its final sentence. Give only the complete translation and at most one brief clarification. Do not advance the lesson or ask a new question. After this response, resume speaking only in ${targetLanguage.promptName}.`,
              )
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
      await this.options.courses?.recordLesson(scope, claimed, report, input.turns);
      const completed = await journal.complete(scope, id, report);
      await this.options.roadmaps?.recordEvidence(scope, claimed, report).catch(() => undefined);
      if (this.options.proficiency)
        await this.options.proficiency
          .recordLessonEvidence(scope, claimed, report)
          .catch(() => undefined);
      else if (report.assessment.overallLevel && report.assessment.evidenceSufficient)
        await this.options.profiles
          .recordSystemAssessment?.(scope, {
            languageCode: claimed.targetLanguageCode,
            level: report.assessment.overallLevel,
            confidence: { low: 0.35, medium: 0.7, high: 0.9 }[report.assessment.confidence],
          })
          .catch(() => undefined);
      return publicStoredLesson(completed);
    } catch (error) {
      const failureCode = privateLessonReportFailureCode(error);
      await journal.fail(scope, id, failureCode);
      throw new AppError(
        503,
        'PRIVATE_LESSON_REPORT_FAILED',
        'The lesson ended, but its report could not be generated yet',
        { reason: failureCode },
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

  async getSetup(scope: ProfileScope, targetLanguageCode: string) {
    const [profile, preferences, roadmap] = await Promise.all([
      this.options.profiles.getProfile(scope),
      this.options.roadmaps?.getPreferences(scope, targetLanguageCode) ?? Promise.resolve(null),
      this.options.roadmaps?.getActive(scope, targetLanguageCode) ?? Promise.resolve(null),
    ]);
    return setupPayload(profileLevel(profile, targetLanguageCode), preferences, roadmap);
  }

  async createRoadmap(
    scope: ProfileScope,
    input: { targetLanguageCode: string; goalKind: PrivateLessonGoalKind; goalKey: string },
  ) {
    if (!this.options.roadmaps)
      throw new AppError(
        503,
        'PRIVATE_LESSON_ROADMAPS_NOT_CONFIGURED',
        'Learning roadmaps are unavailable',
      );
    const profile = await this.options.profiles.getProfile(scope);
    return {
      roadmap: await this.options.roadmaps.create(
        scope,
        input.targetLanguageCode,
        input.goalKind,
        input.goalKey,
        profileLevel(profile, input.targetLanguageCode),
      ),
    };
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
    preferences: Awaited<ReturnType<PrivateLessonRoadmapStore['getPreferences']>>,
    activeRoadmap: Awaited<ReturnType<PrivateLessonRoadmapStore['getActive']>>,
  ) {
    const languageProfile = profile.languages.find(
      (language) =>
        new Intl.Locale(language.languageCode).language ===
        new Intl.Locale(input.targetLanguageCode).language,
    );
    const lessonMode = input.lessonMode ?? preferences?.lessonMode ?? 'standard';
    const level =
      lessonMode === 'absolute_beginner'
        ? 'A1'
        : (input.requestedLevel ??
          languageProfile?.effectiveLevel ??
          languageProfile?.selfAssessedLevel ??
          ('A2' satisfies CefrLevel));
    const profileSupportLanguage = profile.defaultTranslationLanguage;
    const supportLanguageCode =
      input.supportLanguageCode === undefined && preferences
        ? preferences.supportLanguageCode
        : input.supportLanguageCode === undefined
          ? profileSupportLanguage &&
            new Intl.Locale(profileSupportLanguage).language !==
              new Intl.Locale(input.targetLanguageCode).language
            ? profileSupportLanguage
            : null
          : input.supportLanguageCode;
    if (lessonMode === 'absolute_beginner' && !supportLanguageCode)
      throw new AppError(
        400,
        'PRIVATE_LESSON_SUPPORT_LANGUAGE_REQUIRED',
        'Absolute beginner lessons require a support language',
      );
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
    const currentMilestone =
      lessonMode === 'absolute_beginner'
        ? null
        : (activeRoadmap?.milestones.find((item) => item.status === 'current') ?? null);
    const focusAreas = [
      ...new Set([
        ...(input.focusAreas ??
          preferences?.focusAreas ??
          previousLesson?.focusAreas ?? ['speaking', 'vocabulary']),
        ...(input.grammarFocus || currentMilestone?.grammarTopics.length
          ? (['grammar'] as const)
          : []),
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
      durationSeconds:
        (input.requestedDurationMinutes ?? preferences?.requestedDurationMinutes)
          ? (input.requestedDurationMinutes ?? preferences!.requestedDurationMinutes) * 60
          : this.durationSeconds,
      targetLanguageCode: input.targetLanguageCode,
      supportLanguageCode,
      lessonMode,
      level,
      topic:
        input.topic ??
        currentMilestone?.communicationObjective ??
        profile.interests[0] ??
        'everyday conversation',
      grammarFocus: input.grammarFocus ?? (currentMilestone?.grammarTopics.join(', ') || null),
      focusAreas,
      customFocus:
        input.customFocus === undefined
          ? (preferences?.customFocus ?? previousLesson?.customFocus ?? null)
          : input.customFocus,
      correctionMode:
        input.correctionMode ??
        preferences?.correctionMode ??
        previousLesson?.correctionMode ??
        'recast',
      vocabularyMode,
      teacherVoice: input.teacherVoice ?? preferences?.teacherVoice ?? 'female',
      speechRate: input.speechRate ?? preferences?.speechRate ?? 'normal',
      interests: profile.interests.slice(0, 10),
      targets,
      continuity,
      roadmap:
        activeRoadmap && currentMilestone
          ? {
              roadmapId: activeRoadmap.id,
              milestoneId: currentMilestone.id,
              milestoneKey: currentMilestone.key,
              goalTitle: activeRoadmap.goalTitle,
              communicationObjective: currentMilestone.communicationObjective,
              grammarTopics: currentMilestone.grammarTopics,
              successCriteria: currentMilestone.successCriteria,
              evidenceLessonCount: currentMilestone.evidenceLessonCount,
              // A disconnected or abandoned session is not evidence that the learner
              // received the foundation. Keep teaching the introduction until the
              // milestone has at least one completed piece of learning evidence.
              isFirstMilestoneLesson: currentMilestone.evidenceLessonCount === 0,
            }
          : null,
    } satisfies PrivateLessonPlan;
  }
}

function publicStoredLesson(lesson: StoredPrivateLesson) {
  return {
    course: lesson.course ?? null,
    id: lesson.id,
    targetLanguageCode: lesson.targetLanguageCode,
    supportLanguageCode: lesson.supportLanguageCode,
    lessonMode: lesson.lessonMode,
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
    roadmap: lesson.roadmap,
    status: lesson.status,
    startedAt: lesson.startedAt,
    endedAt: lesson.endedAt,
    report: lesson.report,
  };
}

function publicPlan(plan: PrivateLessonPlan) {
  const wrapUpLeadSeconds = Math.min(5, Math.max(3, Math.floor(plan.durationSeconds * 0.02)));
  return {
    course: plan.course ?? null,
    id: plan.id,
    durationSeconds: plan.durationSeconds,
    wrapUpAfterSeconds: Math.max(0, plan.durationSeconds - wrapUpLeadSeconds),
    targetLanguageCode: plan.targetLanguageCode,
    supportLanguageCode: plan.supportLanguageCode,
    lessonMode: plan.lessonMode,
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
    roadmap: plan.roadmap,
  };
}

function profileLevel(profile: GotItProfile, targetLanguageCode: string): CefrLevel {
  const base = new Intl.Locale(targetLanguageCode).language;
  const language = profile.languages.find(
    (item) => new Intl.Locale(item.languageCode).language === base,
  );
  return language?.effectiveLevel ?? language?.selfAssessedLevel ?? 'A2';
}

function safetyIdentifier(scope: ProfileScope) {
  return createHash('sha256')
    .update(`gotit-private-lesson:${scope.applicationId}:${scope.applicationUserId}`)
    .digest('hex');
}

function privateLessonReportFailureCode(error: unknown): PrivateLessonReportFailureCode {
  const providerFailure = providerFailureCode(error);
  if (providerFailure) return `provider_${providerFailure}`;
  if (error instanceof PrivateLessonSummaryError) {
    if (error.reason === 'output_limit') return 'output_limit';
    if (error.reason === 'content_filter') return 'content_filter';
    if (error.reason === 'refusal') return 'refusal';
    return 'incomplete_response';
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) return 'invalid_report';
  return 'generation_failed';
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
