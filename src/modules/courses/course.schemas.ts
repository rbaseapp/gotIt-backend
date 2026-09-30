import { z } from 'zod';
import { languageSchema } from '../capture/capture.validation.js';
import { CEFR_LEVELS } from '../profile/profile.types.js';

const text = (max = 500) => z.string().trim().min(1).max(max);
export const coursePreferencesSchema = z
  .object({
    targetLanguageCode: languageSchema,
    supportLanguageCode: languageSchema,
    path: z.enum(['comprehensive', 'grammar', 'goal']),
    goal: text(),
    experience: text(),
    startingLevel: z.enum(CEFR_LEVELS),
    absoluteBeginner: z.boolean(),
    ageGroup: z.enum(['child', 'teen', 'adult', 'unspecified']),
    literacy: z.enum(['not_yet', 'developing', 'independent', 'unspecified']),
    minutesPerLesson: z.union([z.literal(5), z.literal(10), z.literal(15)]),
    daysPerWeek: z.number().int().min(1).max(7),
    interests: z.array(text(100)).max(8),
    statedNeeds: z.array(text(300)).max(8),
    recommendations: z.array(text(300)).max(6),
  })
  .strict();
export type CoursePreferences = z.infer<typeof coursePreferencesSchema>;
export const intakeReplySchema = z
  .object({
    message: text(1200),
    suggestions: z.array(text(120)).max(3),
    ready: z.boolean(),
    preferences: coursePreferencesSchema,
  })
  .strict();
export const courseUnitSchema = z
  .object({
    key: text(70).regex(/^[a-z0-9-]+$/),
    title: text(150),
    outcome: text(350),
    level: z.enum(CEFR_LEVELS),
    prerequisites: z.array(text(70)).max(8),
    syllabusKeys: z.array(text(70)).max(20),
    grammar: z.array(text(160)).max(12),
    vocabulary: z.array(text(120)).max(8),
    lessons: z
      .array(z.object({ title: text(150), objective: text(350) }).strict())
      .min(2)
      .max(10),
    estimatedMinutes: z.number().int().min(10).max(600),
    homeworkExample: text(350),
    successTask: text(350),
  })
  .strict();
export const coursePlanSchema = z
  .object({
    title: text(160),
    outcome: text(500),
    scope: text(700),
    changeSummary: text(700),
    units: z.array(courseUnitSchema).min(3).max(40),
  })
  .strict();
export type CoursePlan = z.infer<typeof coursePlanSchema>;
export type CourseUnit = z.infer<typeof courseUnitSchema>;
export type CourseVersion = {
  version: number;
  preferences: CoursePreferences;
  plan: CoursePlan;
  createdAt: string;
};
export type CourseEvidence = {
  lessonId: string;
  version: number;
  unitKey: string;
  lessonIndex: number;
  covered: boolean;
  independent: boolean;
  recordedAt: string;
};
export type CourseDocument = {
  kind: 'course';
  id: string;
  revision: number;
  createdAt: string;
  preferences: CoursePreferences;
  approvedPreferences: CoursePreferences | null;
  preferencesApprovedAt: string | null;
  ready: boolean;
  messages: Array<{ role: 'learner' | 'tutor'; text: string; channel: 'text' | 'voice' }>;
  suggestions: string[];
  versions: CourseVersion[];
  draftVersion: number | null;
  activeVersion: number | null;
  evidence: CourseEvidence[];
  pendingPlanChange?: string;
};
export type CourseLessonContext = {
  courseId: string;
  version: number;
  unitKey: string;
  lessonIndex: number;
  courseTitle: string;
  unitTitle: string;
  lessonTitle: string;
  level: CoursePreferences['startingLevel'];
  objective: string;
  successTask: string;
  isUnitCheck: boolean;
  grammar: string[];
  vocabulary: string[];
  preferences: CoursePreferences;
  homework: string;
};
export const homeworkTaskSchema = z
  .object({
    kind: z.enum(['choice', 'fill', 'order', 'transform', 'response', 'listening']),
    objective: text(250),
    prompt: text(600),
    sourceQuote: text(500),
    choices: z.array(text(200)).max(5),
    tokens: z.array(text(80)).max(18),
    listeningText: text(500).nullable(),
    hint: text(400),
    explanation: text(500),
    expectedAnswer: text(500),
    acceptedAnswers: z.array(text(500)).min(1).max(10),
  })
  .strict();
export const homeworkContentSchema = z
  .object({
    title: text(160),
    objective: text(350),
    estimatedMinutes: z.number().int().min(2).max(10),
    tasks: z.array(homeworkTaskSchema).min(2).max(6),
  })
  .strict();
export type HomeworkTask = z.infer<typeof homeworkTaskSchema>;
export const homeworkJudgmentSchema = z
  .object({
    result: z.enum(['correct', 'retry', 'uncertain']),
    feedback: text(500),
  })
  .strict();
export type HomeworkAttempt = {
  answer: string;
  channel: 'text' | 'voice';
  result: 'correct' | 'retry' | 'uncertain' | 'skipped';
  feedback: string;
  independent: boolean;
  createdAt: string;
};
export type HomeworkDocument = {
  kind: 'homework';
  id: string;
  revision: number;
  createdAt: string;
  lessonId: string;
  course: CourseLessonContext | null;
  targetLanguageCode: string;
  supportLanguageCode: string;
  title: string;
  source: { report: unknown; turns: Array<{ role: 'learner' | 'tutor'; text: string }> };
  content: z.infer<typeof homeworkContentSchema> | null;
  progress: Array<{ attempts: HomeworkAttempt[]; hintUsed: boolean; done: boolean; draft: string }>;
};
export type LearningDocument = CourseDocument | HomeworkDocument;
export const commandSchema = z
  .object({ revision: z.number().int().min(0), eventId: z.uuid() })
  .strict();
export const intakeStartSchema = z
  .object({
    eventId: z.uuid(),
    targetLanguageCode: languageSchema,
    supportLanguageCode: languageSchema,
  })
  .strict();
export const courseTurnSchema = commandSchema.extend({
  message: text(1500),
  channel: z.enum(['text', 'voice']),
  mode: z.enum(['preferences', 'plan']),
});
export const homeworkActionSchema = commandSchema.extend({
  taskIndex: z.number().int().min(0).max(5),
  action: z.enum(['answer', 'hint', 'skip', 'draft']),
  answer: z.string().max(1500).default(''),
  channel: z.enum(['text', 'voice']).default('text'),
});
export const speechInputSchema = z
  .object({ audioBase64: z.string().min(60).max(670000), languageCode: languageSchema })
  .strict();
