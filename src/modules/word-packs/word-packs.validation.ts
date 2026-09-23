import { z } from 'zod';
import { uuidSchema } from '../capture/capture.validation.js';

export const addSchema = z
  .object({
    entryIds: z
      .array(uuidSchema)
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length, 'Duplicate entries'),
  })
  .strict();

export const removalSchema = z
  .object({ mode: z.enum(['archive_exclusive', 'keep_words']).default('archive_exclusive') })
  .strict();

export type RemovalInput = z.output<typeof removalSchema>;
export type AddInput = z.output<typeof addSchema>;
