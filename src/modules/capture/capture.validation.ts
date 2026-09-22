import { z } from 'zod';
import { AppError } from '../../shared/errors/app-error.js';

const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
export const normalizeText = (value: string) =>
  value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
export const lookupText = (value: string) => normalizeText(value).toLowerCase();
export function textSchema(max: number) {
  return z
    .string()
    .max(max * 8)
    .refine((v) => !controls.test(v), 'Unsupported control characters')
    .transform(normalizeText)
    .refine((v) => [...v].length >= 1 && [...v].length <= max, 'Text length out of range');
}
export function contextTextSchema(max: number) {
  return z
    .string()
    .max(max * 2 + 100)
    .refine((v) => !controls.test(v), 'Unsupported control characters')
    .transform((v) => v.replace(/\r\n?/gu, '\n').trim())
    .refine((v) => [...v].length <= max, 'Text length out of range');
}
export const languageSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .transform((v, ctx) => {
    try {
      return Intl.getCanonicalLocales(v)[0]!;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid BCP-47 language code' });
      return z.NEVER;
    }
  });
export function sameBaseLanguage(left: string, right: string) {
  return new Intl.Locale(left).language === new Intl.Locale(right).language;
}
export const uuidSchema = z.uuid().transform((v) => v.toLowerCase());
const nullableContext = (max: number) => contextTextSchema(max).nullable().default(null);
const urlSchema = z
  .string()
  .max(2048)
  .transform((v, ctx) => {
    try {
      const url = new URL(v);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error();
      return url.href;
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid HTTP page URL' });
      return z.NEVER;
    }
  });
const contextFields = {
  sentenceText: nullableContext(4000),
  paragraphText: nullableContext(12000),
  pageTitle: nullableContext(500),
  pageUrl: urlSchema.nullable().default(null),
};
export const previewSchema = z
  .object({
    selectedText: textSchema(500),
    sourceText: textSchema(500).optional(),
    sourceLanguageCode: languageSchema.optional(),
    translationLanguageCode: languageSchema.optional(),
    documentLanguageHint: languageSchema.optional(),
    translationMethod: z.enum(['auto', 'dictionary', 'ai']).optional(),
    context: z.object(contextFields).strict().optional(),
  })
  .strict();
export const candidateSchema = z
  .object({
    text: textSchema(1000),
    variants: z.array(textSchema(1000)).max(10).default([]),
    partOfSpeech: textSchema(100).nullable().default(null),
    explanation: textSchema(1000).nullable().default(null),
    phoneticText: textSchema(500).nullable().default(null),
    phoneticScheme: textSchema(100).nullable().default(null),
    examples: z.array(contextTextSchema(4000)).max(5).default([]),
    contextUsed: z.boolean(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.phoneticText === null) !== (v.phoneticScheme === null))
      ctx.addIssue({ code: 'custom', message: 'Phonetic text and scheme must be paired' });
    const forms = [v.text, ...v.variants].map(lookupText);
    if (new Set(forms).size !== forms.length)
      ctx.addIssue({ code: 'custom', message: 'Duplicate translations' });
  });
const timestampSchema = z.iso
  .datetime({ offset: true })
  .transform((v) => new Date(v).toISOString())
  .refine(
    (v) => new Date(v).getTime() >= 0 && new Date(v).getTime() <= Date.now() + 300_000,
    'Captured time out of range',
  );
export const saveSchema = z
  .object({
    item: z
      .object({
        sourceText: textSchema(500),
        sourceLanguageCode: languageSchema,
        translationLanguageCode: languageSchema,
        itemType: z
          .enum(['word', 'phrase', 'expression', 'phrasal_verb', 'other'])
          .default('other'),
        partOfSpeech: textSchema(100).nullable().default(null),
        phoneticText: textSchema(500).nullable().default(null),
        phoneticScheme: textSchema(100).nullable().default(null),
      })
      .strict(),
    translation: z
      .object({
        text: textSchema(1000),
        variants: z.array(textSchema(1000)).max(10).default([]),
        selectionToken: z.string().min(1).max(65536).optional(),
      })
      .strict(),
    context: z
      .object({
        ...contextFields,
        selectedText: textSchema(500),
        sourceType: z
          .enum(['chrome_extension', 'web_manual', 'api', 'import', 'other'])
          .default('web_manual'),
        capturedAt: timestampSchema.nullable().default(null),
      })
      .strict(),
    senseDecision: z.discriminatedUnion('mode', [
      z.object({ mode: z.literal('auto') }).strict(),
      z.object({ mode: z.literal('create_new_sense') }).strict(),
      z.object({ mode: z.literal('merge'), learningItemId: uuidSchema }).strict(),
    ]),
    clientEventId: uuidSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const forms = [v.translation.text, ...v.translation.variants].map(lookupText);
    if (new Set(forms).size !== forms.length)
      ctx.addIssue({
        code: 'custom',
        message: 'Duplicate translations',
        path: ['translation', 'variants'],
      });
    if ((v.item.phoneticText === null) !== (v.item.phoneticScheme === null))
      ctx.addIssue({
        code: 'custom',
        message: 'Phonetic text and scheme must be paired',
        path: ['item'],
      });
    if (sameBaseLanguage(v.item.sourceLanguageCode, v.item.translationLanguageCode))
      ctx.addIssue({
        code: 'custom',
        message: 'Source and translation languages must differ',
        path: ['item', 'translationLanguageCode'],
      });
  });
export type SaveInput = z.output<typeof saveSchema>;
export type PreviewInput = z.output<typeof previewSchema>;
export type Candidate = z.output<typeof candidateSchema>;
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', {
      fields: parsed.error.issues.map((i) => ({
        path: i.path.map(String).join('.'),
        code: i.code,
      })),
    });
  return parsed.data;
}
