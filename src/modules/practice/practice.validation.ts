import { z } from 'zod';
import { uuidSchema, textSchema } from '../capture/capture.validation.js';
export const sessionTypes = [
  'smart_review',
  'flashcards',
  'recall',
  'listening_spelling',
  'matching',
  'pronunciation',
  'article_quiz',
  'manual',
] as const;
const itemIds = z
  .array(uuidSchema)
  .min(1)
  .max(100)
  .refine((v) => new Set(v).size === v.length, 'Duplicate items');
export const sessionScopeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pack'), id: uuidSchema }).strict(),
  z.object({ type: z.literal('track'), id: uuidSchema }).strict(),
  z.object({ type: z.literal('topic'), id: uuidSchema }).strict(),
]);
export const sessionSchema = z
  .object({
    sessionType: z.enum(sessionTypes),
    learningItemIds: itemIds.optional(),
    readingId: uuidSchema.optional(),
    scope: sessionScopeSchema.optional(),
    count: z.number().int().min(1).max(100).default(10),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.sessionType === 'article_quiz') !== Boolean(v.readingId))
      ctx.addIssue({ code: 'custom', message: 'Article quiz requires readingId' });
    if (v.scope && (v.learningItemIds || v.readingId))
      ctx.addIssue({
        code: 'custom',
        message: 'Session scope cannot be combined with explicit items',
      });
  });
export const closeSessionSchema = z.object({ status: z.enum(['completed', 'abandoned']) }).strict();
export const exercisesSchema = z
  .object({
    count: z.number().int().min(1).max(100).default(5),
    exerciseType: z
      .enum([
        'flashcards',
        'recall',
        'listening_spelling',
        'matching',
        'pronunciation',
        'article_quiz',
      ])
      .optional(),
    kind: z.enum(['typed', 'multiple_choice']).default('typed'),
    direction: z.enum(['source_to_translation', 'translation_to_source']).optional(),
  })
  .strict();
export const attemptSchema = z
  .object({
    exerciseId: uuidSchema,
    answerText: textSchema(2000).optional(),
    choiceId: uuidSchema.optional(),
    selfRating: z.enum(['again', 'hard', 'good', 'easy']).optional(),
    skipped: z.boolean().default(false),
    hintsUsed: z.number().int().min(0).max(10).default(0),
    responseTimeMs: z.number().int().min(0).max(3600000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const count =
      Number(v.answerText !== undefined) +
      Number(v.choiceId !== undefined) +
      Number(v.selfRating !== undefined) +
      Number(v.skipped);
    if (count !== 1)
      ctx.addIssue({
        code: 'custom',
        message: 'Exactly one answer, choice, self-rating or skip is required',
      });
  });
export type SessionInput = z.output<typeof sessionSchema>;
export type SessionScope = z.output<typeof sessionScopeSchema>;
export type ExercisesInput = z.output<typeof exercisesSchema>;
export type AttemptInput = z.output<typeof attemptSchema>;
