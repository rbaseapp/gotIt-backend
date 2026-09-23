import { z } from 'zod';

export const removalSchema = z
  .object({ mode: z.enum(['archive_exclusive', 'keep_words']).default('archive_exclusive') })
  .strict();

export type RemovalInput = z.output<typeof removalSchema>;
