import { z } from 'zod';
import { adaptivePlanSchema } from './teaching-plan.schema.js';

const text = (max: number) => z.string().trim().min(1).max(max);
export const authoredTaskSchema = z
  .object({
    kind: z.enum(['choice', 'fill', 'order', 'transform', 'response', 'listening']),
    objective: text(250),
    sourceActivityId: text(60).optional(),
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
    adaptationPolicy: z.enum(['within_objective', 'authored_only']).optional(),
    objective: z.string().max(350).optional(),
    prohibitedTopics: z.array(text(160)).max(20).optional(),
    teachingPlan: adaptivePlanSchema.optional(),
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
  .strict()
  .superRefine((material, ctx) => {
    const activities = material.teachingPlan?.activities ?? [];
    if (new Set(activities.map((activity) => activity.id)).size !== activities.length)
      ctx.addIssue({ code: 'custom', path: ['teachingPlan'], message: 'Duplicate activity ids' });
    for (const [index, task] of (material.practice?.tasks ?? []).entries()) {
      if (
        task.sourceActivityId &&
        !activities.some((activity) => activity.id === task.sourceActivityId)
      )
        ctx.addIssue({
          code: 'custom',
          path: ['practice', 'tasks', index, 'sourceActivityId'],
          message: 'Select an activity in this lesson',
        });
      if (!task.acceptedAnswers.includes(task.expectedAnswer))
        ctx.addIssue({
          code: 'custom',
          path: ['practice', 'tasks', index],
          message: 'Expected answer must be accepted',
        });
      if (
        task.kind === 'choice' &&
        (task.choices.length < 2 || !task.choices.includes(task.expectedAnswer))
      )
        ctx.addIssue({
          code: 'custom',
          path: ['practice', 'tasks', index],
          message: 'Include the expected answer among choices',
        });
      if (task.kind === 'order' && task.tokens.length < 2)
        ctx.addIssue({
          code: 'custom',
          path: ['practice', 'tasks', index],
          message: 'Supply the tokens to order',
        });
      if (task.kind === 'listening' && !task.listeningText)
        ctx.addIssue({
          code: 'custom',
          path: ['practice', 'tasks', index],
          message: 'Supply listening text',
        });
    }
  });
export type LessonMaterial = z.infer<typeof lessonMaterialSchema>;
