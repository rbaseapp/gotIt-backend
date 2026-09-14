import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3001),
  LOG_LEVEL: z.string().min(1).default('info'),
  DATABASE_URL: z.string().min(1),
  CORE_API_BASE_URL: z.string().url(),
  CORE_APPLICATION_KEY: z.string().min(1).default('gotit'),
  CORE_AUTH_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(3000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type AppEnv = typeof env;
