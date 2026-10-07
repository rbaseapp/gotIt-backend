import { z } from 'zod';
import { languageSchema, sameBaseLanguage, textSchema } from '../capture/capture.validation.js';
import { CEFR_LEVELS } from '../profile/profile.types.js';
import { privateLessonTurnSchema } from './private-lesson.summary.js';
import {
  communicationGoals,
  grammarTopics,
  privateLessonGoalKinds,
} from './private-lesson.curriculum.js';

export const privateLessonFocusAreas = [
  'speaking',
  'vocabulary',
  'grammar',
  'fluency',
  'pronunciation',
  'listening',
] as const;

export const privateLessonCorrectionModes = [
  'critical_only',
  'recast',
  'deep_explanation',
] as const;

export const privateLessonVocabularyModes = ['learned', 'none'] as const;

export const privateLessonSpeechRates = [
  'very_slow',
  'slow',
  'normal',
  'fast',
  'very_fast',
] as const;

export const privateLessonModes = ['standard', 'absolute_beginner'] as const;
export const privateLessonTeachingLanguages = ['target', 'support'] as const;

export const privateLessonInputSchema = z
  .object({
    courseId: z.uuid().optional(),
    packId: z.uuid().optional(),
    station: z.enum(['supported', 'midpoint', 'review']).optional(),
    interactionMode: z.enum(['guided', 'conversation']).optional(),
    targetLanguageCode: languageSchema,
    supportLanguageCode: languageSchema.nullable().optional(),
    lessonMode: z.enum(privateLessonModes).optional(),
    teachingLanguage: z.enum(privateLessonTeachingLanguages).optional(),
    requestedLevel: z.enum(CEFR_LEVELS).optional(),
    requestedDurationMinutes: z
      .union([z.literal(1), z.literal(5), z.literal(10), z.literal(15), z.literal(20)])
      .optional(),
    teacherVoice: z.enum(['female', 'male']).optional(),
    speechRate: z.enum(privateLessonSpeechRates).optional(),
    topic: textSchema(120).optional(),
    grammarFocus: textSchema(160).optional(),
    focusAreas: z
      .array(z.enum(privateLessonFocusAreas))
      .min(1)
      .max(6)
      .refine((areas) => new Set(areas).size === areas.length, 'Duplicate focus area')
      .optional(),
    customFocus: textSchema(300).nullable().optional(),
    correctionMode: z.enum(privateLessonCorrectionModes).optional(),
    vocabularyMode: z.enum(privateLessonVocabularyModes).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.courseId && value.packId)
      context.addIssue({ code: 'custom', path: ['packId'], message: 'Choose one lesson scope' });
    if (value.station && !value.packId)
      context.addIssue({
        code: 'custom',
        path: ['station'],
        message: 'A station requires a word pack',
      });
    if (value.lessonMode === 'absolute_beginner' && value.teachingLanguage === 'target')
      context.addIssue({
        code: 'custom',
        path: ['teachingLanguage'],
        message: 'Absolute beginner lessons use the support language for teaching',
      });
    if (
      !value.courseId &&
      value.supportLanguageCode &&
      sameBaseLanguage(value.targetLanguageCode, value.supportLanguageCode)
    )
      context.addIssue({
        code: 'custom',
        path: ['supportLanguageCode'],
        message: 'Support language must differ from the target language',
      });
  });

export type PrivateLessonInput = z.output<typeof privateLessonInputSchema>;

export const privateLessonPreferencesInputSchema = z
  .object({
    targetLanguageCode: languageSchema,
    supportLanguageCode: languageSchema.nullable(),
    lessonMode: z.enum(privateLessonModes).default('standard'),
    teachingLanguage: z.enum(privateLessonTeachingLanguages).optional(),
    requestedDurationMinutes: z.union([
      z.literal(1),
      z.literal(5),
      z.literal(10),
      z.literal(15),
      z.literal(20),
    ]),
    teacherVoice: z.enum(['female', 'male']),
    speechRate: z.enum(privateLessonSpeechRates),
    focusAreas: z
      .array(z.enum(privateLessonFocusAreas))
      .min(1)
      .max(6)
      .refine((areas) => new Set(areas).size === areas.length, 'Duplicate focus area'),
    customFocus: textSchema(300).nullable(),
    correctionMode: z.enum(privateLessonCorrectionModes),
    vocabularyMode: z.enum(privateLessonVocabularyModes),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.lessonMode === 'absolute_beginner' && value.teachingLanguage === 'target')
      context.addIssue({
        code: 'custom',
        path: ['teachingLanguage'],
        message: 'Absolute beginner lessons use the support language for teaching',
      });
    if (value.teachingLanguage === 'support' && !value.supportLanguageCode)
      context.addIssue({
        code: 'custom',
        path: ['supportLanguageCode'],
        message: 'A support language is required for teaching in that language',
      });
    if (value.lessonMode === 'absolute_beginner' && !value.supportLanguageCode)
      context.addIssue({
        code: 'custom',
        path: ['supportLanguageCode'],
        message: 'Absolute beginner lessons require a support language',
      });
    if (
      value.supportLanguageCode &&
      sameBaseLanguage(value.targetLanguageCode, value.supportLanguageCode)
    )
      context.addIssue({
        code: 'custom',
        path: ['supportLanguageCode'],
        message: 'Support language must differ from the target language',
      });
  });

export type PrivateLessonPreferencesInput = z.output<typeof privateLessonPreferencesInputSchema>;

export const privateLessonSetupSchema = z.object({ targetLanguageCode: languageSchema }).strict();
export const privateLessonRoadmapInputSchema = z
  .object({
    targetLanguageCode: languageSchema,
    goalKind: z.enum(privateLessonGoalKinds),
    goalKey: z.string().trim().min(1).max(80),
  })
  .strict()
  .superRefine((value, context) => {
    const valid =
      value.goalKind === 'recommended' ||
      (value.goalKind === 'communication' && communicationGoals.includes(value.goalKey as never)) ||
      (value.goalKind === 'grammar' && grammarTopics.some((topic) => topic.key === value.goalKey));
    if (!valid)
      context.addIssue({
        code: 'custom',
        path: ['goalKey'],
        message: 'Goal does not belong to the selected category',
      });
  });

export const privateLessonCompletionSchema = z
  .object({
    actualDurationSeconds: z.number().int().min(0).max(1800),
    completionReason: z.enum(['completed', 'stopped', 'disconnected']),
    turns: z.array(privateLessonTurnSchema).max(200),
  })
  .strict()
  .superRefine((value, context) => {
    const totalCharacters = value.turns.reduce((sum, turn) => sum + [...turn.text].length, 0);
    if (totalCharacters > 40_000)
      context.addIssue({
        code: 'custom',
        path: ['turns'],
        message: 'Lesson transcript is too long',
      });
  });

export const privateLessonListSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    courseId: z.uuid().optional(),
    packId: z.uuid().optional(),
  })
  .strict();

export type PrivateLessonCompletionInput = z.output<typeof privateLessonCompletionSchema>;
