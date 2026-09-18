import { z } from 'zod';
import {
  contextTextSchema,
  languageSchema,
  textSchema,
  uuidSchema,
} from '../capture/capture.validation.js';
export const readingInputSchema = z
  .object({
    topic: textSchema(500).optional(),
    targetLanguageCode: languageSchema,
    requestedLevel: z.enum(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']).optional(),
    contentType: z.enum(['article', 'essay', 'news_style', 'story', 'other']).default('article'),
    lengthPreset: z.enum(['short', 'medium', 'long']).default('short'),
    learningItemIds: z
      .array(uuidSchema)
      .min(1)
      .max(20)
      .refine((v) => new Set(v).size === v.length, 'Duplicate items')
      .optional(),
  })
  .strict();
export const generatedReadingSchema = z
  .object({
    title: textSchema(300),
    bodyText: contextTextSchema(12000).refine((v) => v.length >= 20, 'Reading body is too short'),
  })
  .strict();
export const publicationSchema = z
  .object({ publicationToken: z.string().min(1).max(130000) })
  .strict();
export type ReadingInput = z.output<typeof readingInputSchema>;
export type GeneratedReading = z.output<typeof generatedReadingSchema>;
export type ReadingTarget = {
  id: string;
  sourceText: string;
  translationText: string;
  translationLanguageCode: string;
  partOfSpeech: string | null;
  snapshotHash: string;
};
export type ReadingGenerationInput = ReadingInput & {
  topic: string;
  effectiveLevel: string | null;
  targets: ReadingTarget[];
  repair?: {
    previousTitle: string;
    previousBodyText: string;
    missingTargetTexts: string[];
  };
};
export interface ReadingGenerator {
  readonly id: string;
  generate(
    input: ReadingGenerationInput,
    signal: AbortSignal,
  ): Promise<GeneratedReading & { providerModel: string | null }>;
}
