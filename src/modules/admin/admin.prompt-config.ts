import { z } from 'zod';
import { AppError } from '../../shared/errors/app-error.js';
import { privateLessonInputSchema } from '../private-lessons/private-lesson.validation.js';

export const promptVariables = [
  'baseInstructions',
  'defaultDirective',
  'defaultSection',
  'lessonData',
  'targetLanguage',
  'supportLanguage',
  'teacherName',
  'level',
  'topic',
] as const;
export const lessonSectionKeys = [
  'role',
  'data',
  'language',
  'teaching',
  'pace',
  'child',
  'flow',
  'audio',
] as const;
const template = z
  .string()
  .trim()
  .max(20000)
  .superRefine((text, ctx) => {
    for (const match of text.matchAll(/\{\{([^{}]+)\}\}/g)) {
      if (!promptVariables.includes(match[1]!.trim() as (typeof promptVariables)[number]))
        ctx.addIssue({ code: 'custom', message: `Unknown template variable: ${match[1]}` });
    }
  });
const model = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9._:-]+$/);
const turnDetection = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('server_vad'),
      threshold: z.number().min(0).max(1).optional(),
      prefix_padding_ms: z.number().int().min(0).max(5000).optional(),
      silence_duration_ms: z.number().int().min(100).max(5000).optional(),
      interrupt_response: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('semantic_vad'),
      eagerness: z.enum(['low', 'medium', 'high', 'auto']).optional(),
      interrupt_response: z.boolean().optional(),
    })
    .strict(),
]);
export const realtimeConfigSchema = z
  .object({
    // Defaults only: explicit learner settings and owner course/station rules take precedence.
    lessonDefaults: z
      .object(privateLessonInputSchema.shape)
      .omit({
        courseId: true,
        packId: true,
        station: true,
        interactionMode: true,
        interactionProtocol: true,
        targetLanguageCode: true,
      })
      .partial()
      .strict()
      .optional(),
    session: z
      .object({
        model: model.optional(),
        max_output_tokens: z
          .union([z.number().int().min(1).max(4096), z.literal('inf')])
          .optional(),
        audio: z
          .object({
            input: z
              .object({
                noise_reduction: z
                  .object({ type: z.enum(['near_field', 'far_field']) })
                  .strict()
                  .nullable()
                  .optional(),
                transcription: z
                  .object({
                    model: model.optional(),
                    language: z
                      .string()
                      .regex(/^[a-z]{2,3}$/)
                      .nullable()
                      .optional(),
                    prompt: template.optional(),
                  })
                  .strict()
                  .optional(),
                turn_detection: turnDetection.optional(),
              })
              .strict()
              .optional(),
            output: z
              .object({
                voice: z
                  .enum([
                    'alloy',
                    'ash',
                    'ballad',
                    'coral',
                    'echo',
                    'sage',
                    'shimmer',
                    'verse',
                    'marin',
                    'cedar',
                  ])
                  .optional(),
                speed: z.number().min(0.25).max(1.5).optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    stages: z
      .object({
        opening: template.optional(),
        continuation: template.optional(),
        wrapUp: template.optional(),
        translation: template.optional(),
      })
      .strict()
      .optional(),
    sections: z
      .object(
        Object.fromEntries(lessonSectionKeys.map((key) => [key, template.optional()])) as Record<
          (typeof lessonSectionKeys)[number],
          z.ZodOptional<typeof template>
        >,
      )
      .strict()
      .optional(),
  })
  .strict();
export const promptContentSchema = z
  .object({
    instructions: template,
    mode: z.enum(['append', 'replace']).optional(),
    modules: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/),
            title: z.string().trim().min(1).max(120),
            enabled: z.boolean(),
            text: template,
          })
          .strict(),
      )
      .max(24)
      .optional(),
    realtime: realtimeConfigSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = value.modules?.map((m) => m.key) ?? [];
    const nonSectionText = [
      value.instructions,
      ...(value.modules ?? []).map((m) => m.text),
      ...Object.values(value.realtime?.stages ?? {}),
      value.realtime?.session?.audio?.input?.transcription?.prompt ?? '',
    ].join('\n');
    if (/\{\{\s*defaultSection\s*\}\}/.test(nonSectionText))
      ctx.addIssue({
        code: 'custom',
        path: ['instructions'],
        message: 'defaultSection is only available in base section overrides',
      });
    if (
      Object.values(value.realtime?.sections ?? {}).some((text) =>
        /\{\{\s*defaultDirective\s*\}\}/.test(text ?? ''),
      )
    )
      ctx.addIssue({
        code: 'custom',
        path: ['realtime', 'sections'],
        message: 'defaultDirective is only available in stage instructions',
      });
    if (
      value.realtime?.lessonDefaults?.lessonMode === 'absolute_beginner' &&
      value.realtime.lessonDefaults.teachingLanguage === 'target'
    )
      ctx.addIssue({
        code: 'custom',
        path: ['realtime', 'lessonDefaults', 'teachingLanguage'],
        message: 'Absolute beginner lessons require support teaching language',
      });
    const instructionText = [value.instructions, ...(value.modules ?? []).map((m) => m.text)].join(
      '\n',
    );
    if (/\{\{\s*defaultDirective\s*\}\}/.test(instructionText))
      ctx.addIssue({
        code: 'custom',
        path: ['instructions'],
        message: 'defaultDirective is only available in stage instructions',
      });
    const transcriptionText = value.realtime?.session?.audio?.input?.transcription?.prompt ?? '';
    if (/\{\{\s*defaultDirective\s*\}\}/.test(transcriptionText))
      ctx.addIssue({
        code: 'custom',
        path: ['realtime', 'session', 'audio', 'input', 'transcription', 'prompt'],
        message: 'defaultDirective is only available in stage instructions',
      });
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: 'custom', path: ['modules'], message: 'Module keys must be unique' });
    if (
      value.mode === 'replace' &&
      !value.instructions &&
      !value.modules?.some((m) => m.enabled && m.text)
    )
      ctx.addIssue({
        code: 'custom',
        path: ['instructions'],
        message: 'Replacement instructions cannot be empty',
      });
    const texts = [
      value.instructions,
      ...(value.modules ?? []).map((m) => m.text),
      ...Object.values(value.realtime?.stages ?? {}),
      ...Object.values(value.realtime?.sections ?? {}),
      value.realtime?.session?.audio?.input?.transcription?.prompt ?? '',
    ];
    if (texts.join('').length > 60000)
      ctx.addIssue({ code: 'custom', message: 'Combined prompt text exceeds 60000 characters' });
  });
export type PromptContent = z.infer<typeof promptContentSchema>;
export function validatePromptContent(key: string, value: unknown): PromptContent {
  const content = promptContentSchema.parse(value);
  if (key !== 'lesson-live') {
    if (content.realtime)
      throw new z.ZodError([
        { code: 'custom', path: ['realtime'], message: 'Realtime settings belong to lesson-live' },
      ]);
    const text = [content.instructions, ...(content.modules ?? []).map((m) => m.text)].join('\n');
    if ([...text.matchAll(/\{\{([^{}]+)\}\}/g)].some((m) => m[1]!.trim() !== 'baseInstructions'))
      throw new z.ZodError([
        {
          code: 'custom',
          path: ['instructions'],
          message: 'Lesson variables belong to lesson-live',
        },
      ]);
  }
  return content;
}
export function renderPromptTemplate(text: string, variables: Record<string, string>) {
  // A single literal substitution pass. Never evaluate code or expand inserted learner strings.
  let expandedLength = text.length;
  return text.replace(/\{\{([^{}]+)\}\}/g, (match, key: string) => {
    const replacement = variables[key.trim()] ?? '';
    expandedLength += replacement.length - match.length;
    if (expandedLength > 128000)
      throw new AppError(
        400,
        'PROMPT_CONFIG_INVALID',
        'Expanded prompt exceeds the 128000 character limit. Reduce repeated template variables.',
      );
    return replacement;
  });
}
export function composePrompt(
  base: string,
  content?: PromptContent,
  variables: Record<string, string> = {},
) {
  if (!content) return base;
  const values = { ...variables, baseInstructions: base };
  const parts = [
    content.instructions,
    ...(content.modules ?? []).filter((m) => m.enabled).map((m) => m.text),
  ]
    .filter(Boolean)
    .map((text) => renderPromptTemplate(text, values));
  return [content.mode === 'replace' ? '' : base, ...parts].filter(Boolean).join('\n\n');
}
