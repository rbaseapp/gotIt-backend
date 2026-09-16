import { z } from 'zod';
import { SKILLS } from '../learning/learning.policy.js';
import { sessionTypes } from './practice.validation.js';
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true });
export const sessionReceiptSchema = z
  .object({
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    data: z
      .object({
        id: z.uuid(),
        sessionType: z.enum(sessionTypes),
        status: z.enum(['active', 'completed', 'abandoned']),
        startedAt: timestamp.nullable(),
        endedAt: timestamp.nullable(),
        durationSeconds: count.nullable(),
        itemCount: count,
        attemptCount: count,
        correctCount: count,
        xpEarned: count,
        algorithmVersion: z.string().min(1).max(100),
      })
      .strict(),
  })
  .strict();
export const attemptReceiptSchema = z
  .object({
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    data: z
      .object({
        attempt: z
          .object({
            id: z.uuid(),
            learningItemId: z.uuid(),
            sessionId: z.uuid(),
            sequence: count,
            result: z.enum(['correct', 'partially_correct', 'incorrect', 'skipped', 'self_rated']),
            score: z.number().min(0).max(100),
            expectedAnswer: z.string().max(4000).nullable(),
            xpEarned: count,
          })
          .strict(),
        progress: z
          .object({
            status: z.enum(['new', 'learning', 'reviewing', 'mastered']),
            stage: count,
            masterySource: z.string().max(100).nullable(),
            masteryScore: z.number().min(0).max(100),
            nextReviewAt: timestamp.nullable(),
          })
          .strict(),
        skills: z
          .array(
            z
              .object({
                skillType: z.enum(SKILLS),
                masteryScore: z.number().min(0).max(100),
                confidence: z.number().min(0).max(1),
                attemptCount: count,
                successCount: count,
                failureCount: count,
                calendarDays: count,
              })
              .strict(),
          )
          .max(5),
        algorithmVersion: z.string().min(1).max(100),
      })
      .strict(),
  })
  .strict();
