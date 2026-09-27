import { z } from 'zod';
import { languageSchema, sameBaseLanguage, textSchema } from '../capture/capture.validation.js';
import { CEFR_LEVELS } from '../profile/profile.types.js';
import { privateLessonTurnSchema } from './private-lesson.summary.js';

export const privateLessonFocusAreas = [
  'speaking',
  'vocabulary',
  'grammar',
  'fluency',
  'pronunciation',
  'listening',
] as const;

export const privateLessonInputSchema = z
  .object({
    targetLanguageCode: languageSchema,
    supportLanguageCode: languageSchema.nullable().optional(),
    requestedLevel: z.enum(CEFR_LEVELS).optional(),
    requestedDurationMinutes: z
      .union([z.literal(1), z.literal(5), z.literal(10), z.literal(15)])
      .optional(),
    teacherVoice: z.enum(['female', 'male']).optional(),
    speechRate: z.enum(['slow', 'normal', 'fast']).optional(),
    topic: textSchema(120).optional(),
    grammarFocus: textSchema(160).optional(),
    focusAreas: z
      .array(z.enum(privateLessonFocusAreas))
      .min(1)
      .max(6)
      .refine((areas) => new Set(areas).size === areas.length, 'Duplicate focus area')
      .optional(),
    customFocus: textSchema(300).nullable().optional(),
  })
  .strict()
  .superRefine((value, context) => {
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

export type PrivateLessonInput = z.output<typeof privateLessonInputSchema>;

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
  .object({ limit: z.coerce.number().int().min(1).max(50).default(20) })
  .strict();

export type PrivateLessonCompletionInput = z.output<typeof privateLessonCompletionSchema>;
