import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
export const adaptiveActivitySchema = z
  .object({
    id: text(60),
    family: text(100),
    objective: text(250),
    kind: z.enum([
      'meaning',
      'guided_use',
      'recall',
      'contrast',
      'information_gap',
      'role_play',
      'transfer',
    ]),
    route: z.enum(['core', 'support', 'extension']),
    context: text(250),
    prompt: text(350),
    hint: text(350),
    criterion: text(500),
    requiredWords: z.array(text(120)).max(20),
    estimatedSeconds: z.number().int().min(15).max(150),
    independent: z.boolean(),
  })
  .strict();
export const adaptivePlanSchema = z
  .object({
    version: z.literal('adaptive-v1'),
    opening: text(1500),
    exhaustedMessage: text(700),
    activities: z.array(adaptiveActivitySchema).min(3).max(48),
  })
  .strict();
export type AdaptiveActivity = z.infer<typeof adaptiveActivitySchema>;
export type AdaptivePlan = z.infer<typeof adaptivePlanSchema>;
