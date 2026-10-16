import { z } from 'zod';
import { languageSchema, textSchema, lookupText } from '../capture/capture.validation.js';
import { commandSchema } from '../admin/admin.schemas.js';

export const conceptDocumentSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
    title: textSchema(200),
    definition: textSchema(1000),
    visualDescription: textSchema(500),
    stockSearchQuery: z
      .string()
      .trim()
      .max(100)
      .regex(/^[a-zA-Z0-9 ,'-]*$/)
      .default(''),
    status: z.enum(['active', 'disabled']).default('active'),
    expressions: z
      .array(z.object({ languageCode: languageSchema, text: textSchema(300) }).strict())
      .min(2)
      .max(200),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = value.expressions.map((e) => JSON.stringify([e.languageCode, lookupText(e.text)]));
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({
        code: 'custom',
        path: ['expressions'],
        message: 'Duplicate expressions in the same language',
      });
    if (new Set(value.expressions.map((e) => e.languageCode)).size < 2)
      ctx.addIssue({
        code: 'custom',
        path: ['expressions'],
        message: 'At least two languages are required',
      });
  });
export const conceptSaveSchema = commandSchema
  .extend({
    expectedRevision: z.number().int().nonnegative().nullable(),
    resetImage: z.boolean().default(false),
    document: conceptDocumentSchema,
  })
  .strict();
