import { z } from 'zod';
import { languageSchema, uuidSchema } from '../capture/capture.validation.js';

export const catalogQuerySchema = z
  .object({
    sourceLanguageCode: languageSchema.optional(),
    translationLanguageCode: languageSchema.optional(),
  })
  .strict();
export type CatalogQuery = z.output<typeof catalogQuerySchema>;

export const addSchema = z
  .object({
    entryIds: z
      .array(uuidSchema)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate entries'),
  })
  .strict();

export const knownSchema = z
  .object({
    entryIds: z
      .array(uuidSchema)
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate entries'),
    known: z.boolean(),
  })
  .strict();

export const removalSchema = z
  .object({ mode: z.enum(['archive_exclusive', 'keep_words']).default('archive_exclusive') })
  .strict();

export type RemovalInput = z.output<typeof removalSchema>;
export type AddInput = z.output<typeof addSchema>;
export type KnownInput = z.output<typeof knownSchema>;
