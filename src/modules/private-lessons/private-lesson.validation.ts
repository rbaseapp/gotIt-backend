import { z } from 'zod';
import { languageSchema, sameBaseLanguage, textSchema } from '../capture/capture.validation.js';
import { CEFR_LEVELS } from '../profile/profile.types.js';

export const privateLessonInputSchema = z
  .object({
    targetLanguageCode: languageSchema,
    supportLanguageCode: languageSchema.optional(),
    requestedLevel: z.enum(CEFR_LEVELS).optional(),
    topic: textSchema(120).optional(),
    grammarFocus: textSchema(160).optional(),
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
