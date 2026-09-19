import 'dotenv/config';
import { z } from 'zod';
import { validateOrigins } from '../middleware/cors.js';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().max(65535).default(3001),
    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),
    DATABASE_URL: z.string().min(1),
    CORE_API_BASE_URL: z.string().url(),
    CORE_APPLICATION_KEY: z.string().min(1).default('gotit'),
    CORE_AUTH_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(3000),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    ANTHROPIC_WORKSPACE_ID: z
      .string()
      .trim()
      .regex(/^wrkspc_[A-Za-z0-9]+$/u)
      .optional(),
    AI_TRANSLATION_MODEL: z.string().min(1).max(200).optional(),
    AI_READING_MODEL: z.string().min(1).max(200).optional(),
    CLAUDE_STRUCTURED_OUTPUT: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    ENRICHMENT_SIGNING_SECRET: z.string().min(32).optional(),
    ENRICHMENT_PROFILES_JSON: z.string().min(1).max(32000).optional(),
    GOOGLE_TRANSLATION_API: z.enum(['cloud_basic_v2']).optional(),
    GOOGLE_TRANSLATE_API_KEY: z.string().min(1).optional(),
    GOOGLE_TRANSLATION_LANGUAGES_JSON: z.string().min(1).max(16000).optional(),
    SPEECH_PROVIDER: z.enum(['azure']).optional(),
    AZURE_SPEECH_API_KEY: z.string().min(1).optional(),
    AZURE_SPEECH_REGION: z
      .string()
      .regex(/^[a-z0-9-]{2,50}$/u)
      .optional(),
    AZURE_SPEECH_LANGUAGES_JSON: z.string().min(1).max(16000).optional(),
    CORS_ORIGINS: z
      .string()
      .max(8000)
      .default('')
      .transform((value, ctx) => {
        try {
          return validateOrigins(
            value
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
          );
        } catch {
          ctx.addIssue({ code: 'custom', message: 'Invalid CORS origins' });
          return z.NEVER;
        }
      }),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(3).default(0),
    LEARNING_POLICY_JSON: z.string().max(8000).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.AI_READING_MODEL && (!v.ANTHROPIC_API_KEY || !v.ENRICHMENT_SIGNING_SECRET))
      ctx.addIssue({
        code: 'custom',
        path: ['AI_READING_MODEL'],
        message: 'Reading requires credentials and signing secret',
      });
    if (v.SPEECH_PROVIDER === 'azure') {
      if (!v.AZURE_SPEECH_API_KEY)
        ctx.addIssue({
          code: 'custom',
          path: ['AZURE_SPEECH_API_KEY'],
          message: 'Azure speech provider requires an API key',
        });
      if (!v.AZURE_SPEECH_REGION)
        ctx.addIssue({
          code: 'custom',
          path: ['AZURE_SPEECH_REGION'],
          message: 'Azure speech provider requires a region',
        });
    }
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type AppEnv = typeof env;
