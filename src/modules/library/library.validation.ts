import { z } from 'zod';
import {
  languageSchema,
  textSchema,
  contextTextSchema,
  uuidSchema,
} from '../capture/capture.validation.js';
export const listSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: z.string().max(2048).optional(),
    search: textSchema(500).optional(),
    sourceLanguageCode: languageSchema.optional(),
    translationLanguageCode: languageSchema.optional(),
    userStatus: z.enum(['active', 'paused', 'archived', 'deleted', 'all']).default('all'),
    learningStatus: z.enum(['new', 'learning', 'reviewing', 'mastered']).optional(),
    difficult: z.enum(['true', 'false']).optional(),
    highPriority: z.enum(['true', 'false']).optional(),
    due: z.enum(['true', 'false']).optional(),
    tagId: uuidSchema.optional(),
    packIds: z
      .string()
      .max(3700)
      .transform((value) => value.split(',').filter(Boolean))
      .pipe(
        z
          .array(uuidSchema)
          .min(1)
          .max(100)
          .refine((ids) => new Set(ids).size === ids.length, 'Duplicate packs'),
      )
      .optional(),
    sort: z
      .enum(['recent', 'alphabetical', 'weakest', 'strongest', 'due_next', 'most_practiced'])
      .default('recent'),
  })
  .strict();
export const editSchema = z
  .object({
    sourceText: textSchema(500).optional(),
    sourceLanguageCode: languageSchema.optional(),
    translationLanguageCode: languageSchema.optional(),
    itemType: z.enum(['word', 'phrase', 'expression', 'phrasal_verb', 'other']).optional(),
    partOfSpeech: textSchema(100).nullable().optional(),
    userStatus: z.enum(['active', 'paused', 'archived']).optional(),
    userPriority: z.enum(['normal', 'high']).optional(),
    manualHard: z.boolean().optional(),
    translation: z
      .object({ text: textSchema(1000), variants: z.array(textSchema(1000)).max(10).default([]) })
      .strict()
      .optional(),
    expectedUpdatedAt: z.iso.datetime().optional(),
  })
  .strict()
  .refine(
    (v) => Object.keys(v).some((k) => k !== 'expectedUpdatedAt'),
    'At least one edit field is required',
  );
export const bulkSchema = z
  .object({
    ids: z
      .array(uuidSchema)
      .min(1)
      .max(100)
      .refine((v) => new Set(v).size === v.length, 'Duplicate IDs'),
    action: z.enum([
      'pause',
      'resume',
      'archive',
      'delete',
      'restore',
      'mark_mastered',
      'return_to_learning',
      'high_priority',
      'normal_priority',
      'mark_hard',
      'clear_hard',
    ]),
  })
  .strict();
export const tagSchema = z.object({ name: textSchema(100) }).strict();
export const itemTagsSchema = z
  .object({
    tagIds: z
      .array(uuidSchema)
      .max(50)
      .refine((v) => new Set(v).size === v.length, 'Duplicate tags'),
  })
  .strict();
export const examplesSchema = z
  .object({
    examples: z.array(contextTextSchema(4000).refine((v) => v.length > 0, 'Empty example')).max(20),
  })
  .strict();
export const pageSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: uuidSchema.optional(),
  })
  .strict();
export type ListInput = z.output<typeof listSchema>;
export type EditInput = z.output<typeof editSchema>;
export type BulkInput = z.output<typeof bulkSchema>;
