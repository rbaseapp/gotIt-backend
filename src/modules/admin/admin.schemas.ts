import { z } from 'zod';
import { policySchema } from '../learning/learning.policy.js';
import { coursePlanSchema, coursePreferencesSchema } from '../courses/course.schemas.js';
import { promptContentSchema } from './admin.prompt-config.js';
export const promptKeys = [
  'translation',
  'reading',
  'courses',
  'lesson-summary',
  'lesson-live',
  'image-generation',
  'image-brief',
  'word-pack-examples',
] as const;
export const commandSchema = z.object({
  operationId: z.uuid(),
  reason: z.string().trim().min(3).max(1000),
});
export const listSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    perPage: z.coerce.number().int().min(1).max(100).default(25),
    sort: z
      .enum([
        'id',
        'key',
        'title',
        'name',
        'version',
        'status',
        'createdAt',
        'applicationUserId',
        'operation',
        'model',
        'inputTokens',
        'outputTokens',
        'action',
        'resource',
      ])
      .default('id'),
    order: z.enum(['ASC', 'DESC']).default('ASC'),
    q: z.string().trim().max(200).optional(),
  })
  .strict();
export const usageListSchema = listSchema.extend({ activity: z.literal('failed').optional() });
export const contentSchemas = {
  prompts: promptContentSchema,
  policies: policySchema,
  programs: z
    .object({ preferences: coursePreferencesSchema, plan: coursePlanSchema.nullable() })
    .strict().transform(content=>{
      if(content.plan) for(const unit of content.plan.units) for(const lesson of unit.lessons) {
        const material=lesson.material;
        if(material&&!material.words.length&&!material.readingPassage&&!material.teacherInstructions&&!material.realtimeInstructions&&!material.practice) delete lesson.material;
      }
      return content;
    }),
  support: z
    .object({
      subject: z.string().trim().min(3).max(200),
      priority: z.enum(['low', 'normal', 'high']),
      messages: z
        .array(
          z.object({
            text: z.string().trim().min(1).max(5000),
            visibility: z.enum(['internal', 'learner']),
            actorId: z.uuid(),
            createdAt: z.iso.datetime(),
          }),
        )
        .max(200),
    })
    .strict(),
};
export type DocumentResource = keyof typeof contentSchemas;
export const documentSchema = z
  .object({
    key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
    title: z.string().trim().min(1).max(200),
    content: z.unknown(),
  })
  .strict();
export const saveSchema = commandSchema
  .extend({ expectedRevision: z.number().int().nonnegative().nullable(), document: documentSchema })
  .strict();
export const assignmentSaveSchema=saveSchema.extend({reviseCompleted:z.boolean().optional()}).strict();
export const publishSchema = commandSchema
  .extend({
    expectedRevision: z.number().int().nonnegative(),
    expectedActiveId: z.uuid().nullable(),
  })
  .strict();
export const assignSchema = commandSchema
  .extend({ applicationUserId: z.uuid(), expectedRevision: z.number().int().nonnegative() })
  .strict();
export const supportCreateSchema = commandSchema
  .extend({
    applicationUserId: z.uuid(),
    subject: z.string().trim().min(3).max(200),
    priority: z.enum(['low', 'normal', 'high']),
    message: z.string().trim().min(1).max(5000),
  })
  .strict();
export const supportUpdateSchema = commandSchema
  .extend({
    expectedRevision: z.number().int().nonnegative(),
    status: z.enum(['open', 'pending', 'resolved']),
    message: z.string().trim().min(1).max(5000).optional(),
    visibility: z.enum(['internal', 'learner']).default('internal'),
  })
  .strict();
export const quotaGrantSchema = commandSchema
  .extend({
    applicationUserId: z.uuid(),
    amount: z.number().int().min(1).max(100),
    endsAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export const generateSchema = commandSchema
  .extend({ expectedRevision: z.number().int().nonnegative() })
  .strict();
