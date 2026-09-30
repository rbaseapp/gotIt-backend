import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../shared/errors/app-error.js';
import type { ProfileScope, ProfileServiceContract } from '../profile/profile.types.js';
import type { PrivateLessonPlan } from '../private-lessons/private-lesson.prompt.js';
import type {
  PrivateLessonReport,
  PrivateLessonTurn,
} from '../private-lessons/private-lesson.summary.js';
import {
  commandFingerprint,
  courseConflict,
  courseNotFound,
  type LearningDocumentStore,
} from './course.repository.js';
import type { CourseGenerator } from './course.provider.js';
import {
  coursePlanSchema,
  intakeReplySchema,
  homeworkContentSchema,
  homeworkJudgmentSchema,
  type CourseDocument,
  type CoursePreferences,
  type HomeworkDocument,
  type LearningDocument,
  type CourseLessonContext,
  type commandSchema,
  type intakeStartSchema,
  type courseTurnSchema,
  type homeworkActionSchema,
} from './course.schemas.js';
import {
  evidenceMatchesActiveUnit,
  nextCourseLesson,
  syllabusFor,
  validateCoursePlan,
} from './course.curriculum.js';

type Command = z.infer<typeof commandSchema>;
const now = () => new Date().toISOString();
export class CourseService {
  constructor(
    readonly store: LearningDocumentStore,
    private readonly profiles: ProfileServiceContract,
    private readonly generator?: CourseGenerator,
  ) {}
  get available() {
    return Boolean(this.generator);
  }
  private ai() {
    if (!this.generator)
      throw new AppError(503, 'COURSE_AI_UNAVAILABLE', 'The course teacher is not configured');
    return this.generator;
  }
  async list(scope: ProfileScope) {
    const [courses, homework] = await Promise.all([
      this.store.list(scope, 'course'),
      this.store.list(scope, 'homework'),
    ]);
    return {
      courses: courses.filter((d): d is CourseDocument => d.kind === 'course').map(publicCourse),
      homework: homework
        .filter((d): d is HomeworkDocument => d.kind === 'homework')
        .map(homeworkSummary),
      available: this.available,
    };
  }
  async course(scope: ProfileScope, id: string) {
    const document = await this.store.get(scope, id);
    if (document?.kind !== 'course') throw courseNotFound();
    return document;
  }
  async homework(scope: ProfileScope, id: string) {
    const document = await this.store.get(scope, id);
    if (document?.kind !== 'homework') throw courseNotFound();
    return document;
  }
  async start(scope: ProfileScope, input: z.infer<typeof intakeStartSchema>) {
    const fingerprint = commandFingerprint(['start', input]);
    const replay = await this.store.replay(scope, input.eventId, fingerprint);
    if (replay) return publicCourse(asCourse(replay));
    const profile = await this.profiles.getProfile(scope);
    const preferences: CoursePreferences = {
      targetLanguageCode: input.targetLanguageCode,
      supportLanguageCode: input.supportLanguageCode,
      path: 'comprehensive',
      goal: 'Build confidence using the language',
      experience: 'Not yet discussed',
      startingLevel:
        profile.languages.find((l) => l.languageCode === input.targetLanguageCode)
          ?.effectiveLevel ?? 'A1',
      absoluteBeginner: false,
      ageGroup: 'unspecified',
      literacy: 'unspecified',
      minutesPerLesson: 10,
      daysPerWeek: 3,
      interests: profile.interests.slice(0, 8),
      statedNeeds: [],
      recommendations: [],
    };
    const reply = await this.ai().generate(
      scope,
      intakeReplySchema,
      'course_intake',
      intakeInstruction,
      { preferences, profile, messages: [], firstTurn: true },
    );
    const course: CourseDocument = {
      kind: 'course',
      id: randomUUID(),
      revision: 0,
      createdAt: now(),
      preferences: {
        ...reply.preferences,
        targetLanguageCode: input.targetLanguageCode,
        supportLanguageCode: input.supportLanguageCode,
      },
      approvedPreferences: null,
      preferencesApprovedAt: null,
      ready: false,
      messages: [{ role: 'tutor', text: reply.message, channel: 'text' }],
      suggestions: reply.suggestions,
      versions: [],
      activeVersion: null,
      draftVersion: null,
      evidence: [],
    };
    return publicCourse(
      asCourse(await this.store.save(scope, course, null, input.eventId, fingerprint)),
    );
  }
  private async current(
    scope: ProfileScope,
    id: string,
    command: Command,
    operation: string,
    payload: unknown = command,
  ) {
    const fingerprint = commandFingerprint([id, operation, payload]);
    const replay = await this.store.replay(scope, command.eventId, fingerprint);
    if (replay) return { replay, fingerprint, document: replay };
    const document = await this.store.get(scope, id);
    if (!document) throw courseNotFound();
    if (document.revision !== command.revision) throw courseConflict();
    return { replay: null, fingerprint, document };
  }
  async turn(scope: ProfileScope, id: string, input: z.infer<typeof courseTurnSchema>) {
    const current = await this.current(scope, id, input, 'turn', input);
    if (current.replay) return publicCourse(asCourse(current.replay));
    const course = asCourse(current.document);
    const messages = [
      ...course.messages,
      { role: 'learner' as const, text: input.message, channel: input.channel },
    ].slice(-40);
    if (input.mode === 'plan') {
      if (!course.approvedPreferences) throw courseConflict();
      const reply = await this.ai().generate(
        scope,
        intakeReplySchema,
        'course_intake',
        `${intakeInstruction} This is a change request for an existing course, not an initial intake. Keep all preferences exactly unchanged except those explicitly affected by the latest request. Do not paraphrase unchanged strings or lists. ready=true. A changed pace, course type, language, or goal must be reviewed before generating a revised plan. For a content-only change, briefly acknowledge it and leave preferences unchanged.`,
        { preferences: course.preferences, messages, requestedPlanChange: input.message },
      );
      if (reply.preferences.targetLanguageCode !== course.preferences.targetLanguageCode)
        throw new AppError(
          400,
          'COURSE_TARGET_CHANGE_NEW',
          'Create a separate course to learn another language',
        );
      const changed =
        commandFingerprint(reply.preferences) !== commandFingerprint(course.approvedPreferences);
      const next: CourseDocument = {
        ...course,
        preferences: reply.preferences,
        ready: true,
        pendingPlanChange: input.message,
        approvedPreferences: changed ? null : course.approvedPreferences,
        preferencesApprovedAt: changed ? null : course.preferencesApprovedAt,
        draftVersion: null,
        messages: [...messages, { role: 'tutor', text: reply.message, channel: 'text' }],
        suggestions: [],
      };
      return publicCourse(
        asCourse(
          await this.store.save(scope, next, input.revision, input.eventId, current.fingerprint),
        ),
      );
    }
    const reply = await this.ai().generate(
      scope,
      intakeReplySchema,
      'course_intake',
      intakeInstruction,
      { preferences: course.preferences, messages, reviewRequested: course.ready },
    );
    const preferences = {
      ...reply.preferences,
      targetLanguageCode: course.preferences.targetLanguageCode,
    };
    if (
      preferences.absoluteBeginner &&
      new Intl.Locale(preferences.targetLanguageCode).language ===
        new Intl.Locale(preferences.supportLanguageCode).language
    )
      throw new AppError(
        400,
        'COURSE_SUPPORT_LANGUAGE_REQUIRED',
        'Choose a different explanation language for beginner lessons',
      );
    const next = {
      ...course,
      preferences,
      ready: reply.ready,
      approvedPreferences: null,
      preferencesApprovedAt: null,
      draftVersion: null,
      suggestions: reply.suggestions,
      messages: [
        ...messages,
        { role: 'tutor' as const, text: reply.message, channel: 'text' as const },
      ],
    };
    return publicCourse(
      asCourse(
        await this.store.save(scope, next, input.revision, input.eventId, current.fingerprint),
      ),
    );
  }
  async updatePreferences(
    scope: ProfileScope,
    id: string,
    input: Command & { preferences: CoursePreferences },
  ) {
    const current = await this.current(scope, id, input, 'preferences', input);
    if (current.replay) return publicCourse(asCourse(current.replay));
    const course = asCourse(current.document);
    if (input.preferences.targetLanguageCode !== course.preferences.targetLanguageCode)
      throw courseConflict();
    const next = {
      ...course,
      preferences: input.preferences,
      approvedPreferences: null,
      preferencesApprovedAt: null,
      draftVersion: null,
      ready: true,
    };
    return publicCourse(
      asCourse(
        await this.store.save(scope, next, input.revision, input.eventId, current.fingerprint),
      ),
    );
  }
  async approvePreferences(scope: ProfileScope, id: string, input: Command) {
    const current = await this.current(scope, id, input, 'approvePreferences');
    if (current.replay) return publicCourse(asCourse(current.replay));
    const course = asCourse(current.document);
    if (
      course.preferences.absoluteBeginner &&
      new Intl.Locale(course.preferences.targetLanguageCode).language ===
        new Intl.Locale(course.preferences.supportLanguageCode).language
    )
      throw new AppError(
        400,
        'COURSE_SUPPORT_LANGUAGE_REQUIRED',
        'Choose a different explanation language for beginner lessons',
      );
    const next = {
      ...course,
      ready: true,
      approvedPreferences: structuredClone(course.preferences),
      preferencesApprovedAt: now(),
      draftVersion: null,
    };
    return publicCourse(
      asCourse(
        await this.store.save(scope, next, input.revision, input.eventId, current.fingerprint),
      ),
    );
  }
  async plan(scope: ProfileScope, id: string, input: Command) {
    const current = await this.current(scope, id, input, 'plan');
    if (current.replay) return publicCourse(asCourse(current.replay));
    const course = asCourse(current.document);
    return this.generatePlan(
      scope,
      course,
      input,
      current.fingerprint,
      course.pendingPlanChange ?? null,
    );
  }
  private async generatePlan(
    scope: ProfileScope,
    course: CourseDocument,
    input: Command,
    fingerprint: string,
    change: string | null,
    messages = course.messages,
  ) {
    if (!course.approvedPreferences || !course.preferencesApprovedAt)
      throw new AppError(
        409,
        'COURSE_PREFERENCES_NOT_APPROVED',
        'Review and approve your preferences first',
      );
    if (course.versions.length >= 30)
      throw new AppError(
        409,
        'COURSE_REVISION_LIMIT',
        'Please create a new course for further changes',
      );
    const previous = course.versions.find(
      (v) => v.version === (course.draftVersion ?? course.activeVersion),
    );
    const preservedKeys = new Set(course.evidence.map((e) => e.unitKey));
    const active = course.versions.find((v) => v.version === course.activeVersion);
    const preservedUnits = active?.plan.units.filter((u) => preservedKeys.has(u.key)) ?? [];
    const preferences = course.approvedPreferences;
    const plan = validateCoursePlan(
      await this.ai().generate(scope, coursePlanSchema, 'course_plan', planInstruction, {
        preferences,
        syllabus: syllabusFor(preferences),
        previousPlan: previous?.plan ?? null,
        requestedChange: change,
        preservedUnits,
      }),
      preferences,
      course,
    );
    const version = course.versions.length + 1;
    const next: CourseDocument = {
      ...course,
      pendingPlanChange: undefined,
      versions: [
        ...course.versions,
        { version, plan, preferences: structuredClone(preferences), createdAt: now() },
      ],
      draftVersion: version,
      messages: [
        ...messages,
        { role: 'tutor' as const, text: plan.changeSummary, channel: 'text' as const },
      ].slice(-40),
      suggestions: [],
    };
    return publicCourse(
      asCourse(await this.store.save(scope, next, input.revision, input.eventId, fingerprint)),
    );
  }
  async activate(scope: ProfileScope, id: string, input: Command & { version: number }) {
    const current = await this.current(scope, id, input, 'activate', input);
    if (current.replay) return publicCourse(asCourse(current.replay));
    const course = asCourse(current.document);
    if (course.draftVersion !== input.version || !course.approvedPreferences)
      throw courseConflict();
    const next = { ...course, activeVersion: input.version, draftVersion: null };
    return publicCourse(
      asCourse(
        await this.store.save(scope, next, input.revision, input.eventId, current.fingerprint),
      ),
    );
  }
  async lessonContext(scope: ProfileScope, id: string): Promise<CourseLessonContext> {
    const course = await this.course(scope, id);
    const next = nextCourseLesson(course);
    if (!next)
      throw new AppError(
        409,
        'COURSE_NO_NEXT_LESSON',
        'Approve a course with a next lesson before starting',
      );
    const documents = await this.store.list(scope, 'homework');
    const homework = documents
      .filter((d): d is HomeworkDocument => d.kind === 'homework' && d.course?.courseId === id)
      .slice(0, 3)
      .map((d) => ({
        lessonTitle: d.title,
        done: d.content !== null && d.progress.every((p) => p.done),
        results: d.progress.map((p, index) => ({
          objective: d.content?.tasks[index]?.objective,
          hintUsed: p.hintUsed,
          attempts: p.attempts.map((a) => ({
            result: a.result,
            independent: a.independent,
            feedback: a.feedback,
          })),
        })),
      }));
    return {
      courseId: id,
      version: next.version.version,
      unitKey: next.unit.key,
      lessonIndex: next.lessonIndex,
      courseTitle: next.version.plan.title,
      unitTitle: next.unit.title,
      objective: next.lesson.objective,
      successTask: next.unit.successTask,
      isUnitCheck: next.lessonIndex === next.unit.lessons.length - 1,
      grammar: next.unit.grammar,
      vocabulary: next.unit.vocabulary,
      preferences: next.version.preferences,
      homework: JSON.stringify(homework),
    };
  }
  async prepareLesson(scope: ProfileScope, plan: PrivateLessonPlan, courseId: string) {
    const context = await this.lessonContext(scope, courseId);
    const course = await this.course(scope, courseId);
    const next = nextCourseLesson(course)!;
    if (
      new Intl.Locale(context.preferences.targetLanguageCode).language !==
      new Intl.Locale(plan.targetLanguageCode).language
    )
      throw courseConflict();
    return {
      ...plan,
      course: context,
      roadmap: null,
      supportLanguageCode: context.preferences.supportLanguageCode,
      lessonMode:
        context.preferences.absoluteBeginner && next.unit.level === 'A1'
          ? ('absolute_beginner' as const)
          : ('standard' as const),
      level: next.unit.level,
      topic: next.lesson.title,
      grammarFocus: next.unit.grammar.join('; ').slice(0, 160) || null,
      durationSeconds: context.preferences.minutesPerLesson * 60,
      interests: context.preferences.interests,
      correctionMode:
        context.preferences.path === 'grammar'
          ? ('deep_explanation' as const)
          : plan.correctionMode,
    };
  }
  async recordLesson(
    scope: ProfileScope,
    lesson: PrivateLessonPlan,
    report: PrivateLessonReport,
    turns: PrivateLessonTurn[],
  ) {
    // Deterministic homework ID = lesson ID; retries never create another assignment.
    const learned =
      turns.some((turn) => turn.role === 'learner' && turn.text.trim()) &&
      turns.some((turn) => turn.role === 'tutor' && turn.text.trim()) &&
      (report.grammarPoints.length > 0 ||
        report.corrections.length > 0 ||
        report.vocabulary.some((item) => item.outcome !== 'not_observed') ||
        report.newWordSuggestions.some(
          (item) =>
            turns.some((turn) => turn.role === 'learner' && turn.text.includes(item.sourceText)) &&
            turns.some((turn) => turn.role === 'tutor' && turn.text.includes(item.sourceText)),
        ) ||
        Object.values(report.assessment.skills).some((skill) => skill.evidence.length > 0));
    if (!learned) return;
    if (!(await this.store.get(scope, lesson.id))) {
      const homework: HomeworkDocument = {
        kind: 'homework',
        id: lesson.id,
        revision: 0,
        createdAt: now(),
        lessonId: lesson.id,
        course: lesson.course ?? null,
        targetLanguageCode: lesson.targetLanguageCode,
        supportLanguageCode: lesson.supportLanguageCode ?? lesson.targetLanguageCode,
        title: lesson.topic,
        source: { report, turns: learningExcerpts(report, turns) },
        content: null,
        progress: [],
      };
      try {
        await this.store.save(
          scope,
          homework,
          null,
          lesson.id,
          commandFingerprint(['lesson-homework', lesson.id]),
        );
      } catch (error) {
        if (!(error instanceof AppError && error.statusCode === 409)) throw error;
      }
    }
    if (!lesson.course) return;
    for (let retry = 0; retry < 3; retry++) {
      const course = await this.course(scope, lesson.course.courseId);
      if (course.evidence.some((e) => e.lessonId === lesson.id)) return;
      const performance = report.assessment.lessonPerformance;
      const independent = Boolean(
        report.roadmapProgress?.taskCompleted &&
          report.roadmapProgress.confidence !== 'low' &&
          performance.independence >= 80 &&
          ['moderate', 'strong'].includes(performance.evidenceQuality),
      );
      course.evidence.push({
        lessonId: lesson.id,
        version: lesson.course.version,
        unitKey: lesson.course.unitKey,
        lessonIndex: lesson.course.lessonIndex,
        covered: true,
        independent,
        recordedAt: now(),
      });
      try {
        await this.store.save(
          scope,
          course,
          course.revision,
          randomUUID(),
          commandFingerprint(['evidence', lesson.id]),
        );
        return;
      } catch (error) {
        if (!(error instanceof AppError && error.statusCode === 409) || retry === 2) throw error;
      }
    }
  }
  async prepareHomework(scope: ProfileScope, id: string, input: Command) {
    const current = await this.current(scope, id, input, 'prepareHomework');
    if (current.replay) return publicHomework(asHomework(current.replay));
    const homework = asHomework(current.document);
    if (homework.content) return publicHomework(homework);
    const content = await this.ai().generate(
      scope,
      homeworkContentSchema,
      'lesson_homework',
      homeworkInstruction,
      {
        targetLanguageCode: homework.targetLanguageCode,
        supportLanguageCode: homework.supportLanguageCode,
        preferences: homework.course?.preferences ?? null,
        source: homework.source,
      },
    );
    for (const task of content.tasks) {
      if (!homework.source.turns.some((turn) => turn.text.includes(task.sourceQuote)))
        throw new AppError(
          503,
          'HOMEWORK_SOURCE_INVALID',
          'Practice must be grounded in this lesson',
        );
      if (
        task.kind === 'choice' &&
        (task.choices.length < 2 || !task.choices.includes(task.expectedAnswer))
      )
        throw new AppError(503, 'HOMEWORK_SOURCE_INVALID', 'Practice choices are incomplete');
      if (task.kind === 'order' && task.tokens.length < 2)
        throw new AppError(503, 'HOMEWORK_SOURCE_INVALID', 'Practice sentence is incomplete');
    }
    const next = {
      ...homework,
      content,
      progress: content.tasks.map(() => ({
        attempts: [],
        hintUsed: false,
        done: false,
        draft: '',
      })),
    };
    return publicHomework(
      asHomework(
        await this.store.save(scope, next, input.revision, input.eventId, current.fingerprint),
      ),
    );
  }
  async homeworkAction(
    scope: ProfileScope,
    id: string,
    input: z.infer<typeof homeworkActionSchema>,
  ) {
    const current = await this.current(scope, id, input, 'homeworkAction', input);
    if (current.replay) return publicHomework(asHomework(current.replay));
    const homework = asHomework(current.document);
    const index = homework.progress.findIndex((p) => !p.done);
    if (!homework.content || index !== input.taskIndex) throw courseConflict();
    const task = homework.content.tasks[index]!;
    const progress = homework.progress[index]!;
    if (input.action === 'draft') progress.draft = input.answer;
    else if (input.action === 'hint') progress.hintUsed = true;
    else if (input.action === 'skip') {
      progress.done = true;
      progress.draft = '';
      progress.attempts.push({
        answer: '',
        channel: input.channel,
        result: 'skipped',
        feedback: '',
        independent: false,
        createdAt: now(),
      });
    } else {
      if (!input.answer.trim()) throw new AppError(400, 'VALIDATION_ERROR', 'Enter an answer');
      const exact = task.acceptedAnswers.some(
        (answer) => normalizeAnswer(answer) === normalizeAnswer(input.answer),
      );
      const judgment = exact
        ? { result: 'correct' as const, feedback: task.explanation }
        : task.kind === 'choice'
          ? { result: 'retry' as const, feedback: task.hint }
          : await this.ai().generate(
              scope,
              homeworkJudgmentSchema,
              'homework_feedback',
              'Evaluate only the stated language objective. Accept equivalent grammatical answers and contractions; do not require one exact string. Ignore irrelevant punctuation. Do not infer pronunciation from transcripts. If ambiguous, return uncertain, not retry. Explain in supportLanguageCode in at most two short sentences. On retry give a hint without revealing the expected answer.',
              {
                task,
                answer: input.answer,
                supportLanguageCode: homework.supportLanguageCode,
                targetLanguageCode: homework.targetLanguageCode,
              },
            );
      const priorScored = progress.attempts.filter((a) => a.result !== 'uncertain').length;
      progress.attempts.push({
        ...judgment,
        answer: input.answer,
        channel: input.channel,
        independent:
          judgment.result === 'correct' &&
          !progress.hintUsed &&
          priorScored === 0 &&
          !['choice', 'order', 'listening'].includes(task.kind),
        createdAt: now(),
      });
      progress.done =
        judgment.result === 'correct' || (judgment.result === 'retry' && priorScored >= 1);
      progress.draft = '';
    }
    return publicHomework(
      asHomework(
        await this.store.save(scope, homework, input.revision, input.eventId, current.fingerprint),
      ),
    );
  }
  async transcribe(scope: ProfileScope, audio: string, language: string) {
    return { text: await this.ai().transcribe(scope, audio, language) };
  }
}

function asCourse(document: LearningDocument): CourseDocument {
  if (document.kind !== 'course') throw courseNotFound();
  return document;
}
function asHomework(document: LearningDocument): HomeworkDocument {
  if (document.kind !== 'homework') throw courseNotFound();
  return document;
}
export function publicCourse(course: CourseDocument) {
  const next = nextCourseLesson(course);
  const evidence = course.evidence.filter((e) =>
    evidenceMatchesActiveUnit(course, e.version, e.unitKey),
  );
  return {
    ...course,
    evidence,
    versions: course.versions.filter(
      (v) => v.version === course.draftVersion || v.version === course.activeVersion,
    ),
    nextLesson: next
      ? {
          unitKey: next.unit.key,
          unitTitle: next.unit.title,
          lessonIndex: next.lessonIndex,
          ...next.lesson,
        }
      : null,
    syllabus: syllabusFor(course.preferences),
    progress: {
      covered: new Set(
        evidence.filter((e) => e.covered).map((e) => `${e.unitKey}:${e.lessonIndex}`),
      ).size,
      demonstrated: new Set(
        evidence.filter((e) => e.independent).map((e) => `${e.unitKey}:${e.lessonIndex}`),
      ).size,
      retention: 'not_assessed' as const,
    },
  };
}
export function homeworkSummary(homework: HomeworkDocument) {
  return {
    id: homework.id,
    lessonId: homework.lessonId,
    courseId: homework.course?.courseId ?? null,
    unitKey: homework.course?.unitKey ?? null,
    title: homework.content?.title ?? homework.title,
    targetLanguageCode: homework.targetLanguageCode,
    createdAt: homework.createdAt,
    status: !homework.content
      ? ('pending' as const)
      : homework.progress.every((p) => p.done)
        ? ('completed' as const)
        : ('ready' as const),
    taskCount: homework.content?.tasks.length ?? 0,
    completedCount: homework.progress.filter((p) => p.done).length,
  };
}
export function publicHomework(homework: HomeworkDocument) {
  return {
    ...homeworkSummary(homework),
    revision: homework.revision,
    supportLanguageCode: homework.supportLanguageCode,
    objective: homework.content?.objective ?? null,
    estimatedMinutes: homework.content?.estimatedMinutes ?? null,
    tasks:
      homework.content?.tasks.map((task, index) => {
        const progress = homework.progress[index]!;
        return {
          kind: task.kind,
          objective: task.objective,
          prompt: task.prompt,
          choices: task.choices,
          tokens: task.tokens,
          listeningText: task.listeningText,
          hint: progress.hintUsed ? task.hint : null,
          solution: progress.done
            ? { answer: task.expectedAnswer, explanation: task.explanation }
            : null,
          ...progress,
        };
      }) ?? [],
  };
}
function normalizeAnswer(value: string) {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[.!?。！？]+$/u, '')
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}
function learningExcerpts(
  report: PrivateLessonReport,
  turns: PrivateLessonTurn[],
): PrivateLessonTurn[] {
  const examples = [
    ...report.grammarPoints.map((point) => point.example),
    ...report.corrections.flatMap((correction) => [correction.original, correction.corrected]),
  ].filter((text): text is string => Boolean(text));
  const extracted = examples.flatMap((text) => {
    const source = turns.find((turn) => turn.text.includes(text));
    return source ? [{ role: source.role, text: text.slice(0, 500) }] : [];
  });
  // A bounded teaching excerpt is retained if the report has too few examples.
  // The complete conversation and all raw audio remain transient.
  if (extracted.length < 2)
    extracted.push(
      ...turns
        .filter((turn) => turn.role === 'tutor')
        .slice(-4)
        .map((turn) => ({ role: turn.role, text: turn.text.slice(0, 500) })),
    );
  return extracted.slice(0, 12);
}
const intakeInstruction = `You are the learner's friendly AI language teacher. Conduct a short needs conversation in preferences.supportLanguageCode. Ask ONE concrete question at a time, with up to three easy suggested replies. Never ask the learner to diagnose CEFR or grammar. Reuse known profile information. Help an unsure learner choose through situations they want to handle. Cover goal (comprehensive, systematic grammar, or practical goal), prior experience, age group/reading comfort separately from proficiency, interests, and available time in roughly 4-6 turns. Do not require a placement test; you may offer one tiny optional modeled activity. A beginner gets a model before any question in the target language. Default suggestions belong in recommendations, not statedNeeds. startingLevel is a provisional teaching estimate, not a tested score. Preserve preferences unless the learner changes them. Localize all free-text preferences. After enough information, ready=true and invite review; if already reviewing apply requested corrections and remain ready. Never approve preferences or create/activate a course on the learner's behalf. For the first turn, greet briefly and ask about the intended outcome; ready=false. Avoid long lists or multiple questions.`;
const planInstruction = `Design a coherent language course in preferences.supportLanguageCode, teaching preferences.targetLanguageCode. Use the actual grammar/writing/phonology of that language; do not translate an English syllabus. All future units must contain real topics, named lessons, practical outcomes, estimated effort, prerequisite keys, and a success task. No placeholders. Comprehensive and grammar paths must cover every supplied syllabus key, progressing foundations through advanced language; normally 12-24 units, grouping related topics. Grammar units name the rule AND its practical use, including tense contrasts, forms, exceptions and advanced clauses where relevant. For goal courses select relevant topics and clearly bound the scope. Keep units already in preservedUnits exactly unchanged, at their existing relative positions, then adapt future units. Reuse stable keys for unchanged units. Unit prerequisites can only refer to earlier unit keys. Lessons progress explanation/model, guided use, independent use; do not use these generic stages as unit titles. Adapt to age and literacy; brief oral activities for non-readers. Every unit needs a concrete homework example limited to that unit's teaching. scope states what the course includes and excludes; do not promise knowledge of every possible rule or guaranteed CEFR. A generated_scope syllabus is a provisional plan, not externally certified completeness; explain this briefly in scope. Never claim existing mastery. changeSummary briefly explains what was created or changed. A requested change cannot secretly replace approved language preferences.`;
const homeworkInstruction = `Create 3-5 short homework tasks (2-3 for young children/non-readers) grounded ONLY in material actually taught in source.turns, using source.report for context. Each task.sourceQuote must copy an exact taught example or learner utterance from one turn. Do not introduce a new grammar form as required practice. New examples may use the same taught structure and vocabulary. New suggested words not actually taught are excluded. Move from recognition to supported production to one independent application. Choose appropriate kinds: choice, fill, order, transform, response, listening. Supply choices only for choice, tokens only for order, listeningText only for listening (otherwise null). Shuffle choices/tokens. acceptedAnswers includes expectedAnswer and natural variants. Do not put the answer in the prompt or hint. Instructions, objective, hint, explanation and title use supportLanguageCode; target examples/answers use targetLanguageCode. For non-readers prefer choice/listening with short speakable labels and oral responses. Keep explanation friendly and focused. No images or audio URLs; the app provides read-aloud. Return private answer keys only in expectedAnswer/acceptedAnswers.`;
