import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
export const authoredTaskSchema = z
  .object({
    kind: z.enum(['choice', 'fill', 'order', 'transform', 'response', 'listening']),
    objective: text(250),
    prompt: text(600),
    sourceQuote: text(500),
    choices: z.array(text(200)).max(5),
    tokens: z.array(text(80)).max(18),
    listeningText: text(500).nullable(),
    hint: text(400),
    explanation: text(500),
    expectedAnswer: text(500),
    acceptedAnswers: z.array(text(500)).min(1).max(10),
  })
  .strict();
export const lessonMaterialSchema = z
  .object({
    words: z
      .array(
        z
          .object({
            sourceText: text(120),
            translationText: text(200),
            exampleText: z.string().max(500).default(''),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    readingPassage: z.string().max(12000).default(''),
    teacherInstructions: z.string().max(6000).default(''),
    realtimeInstructions: z.string().max(12000).default(''),
    practice: z
      .object({
        title: text(160),
        objective: text(350),
        estimatedMinutes: z.number().int().min(2).max(20),
        tasks: z.array(authoredTaskSchema).min(3).max(18),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type LessonMaterial = z.infer<typeof lessonMaterialSchema>;
