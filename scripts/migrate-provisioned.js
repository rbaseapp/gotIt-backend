import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import { migrate } from './migrate.js';
import { preflight } from './preflight.js';

export async function migrateProvisioned(confirmation) {
  if (confirmation !== 'gotit-v1-up') throw new Error('MIGRATION_CONFIRMATION_REQUIRED');
  const values =
    dotenv.config({ path: resolve('.env.production.generated'), quiet: true }).parsed ?? {};
  if (!values.GOTIT_MIGRATION_DATABASE_URL || !values.GOTIT_RUNTIME_EXTERNAL_DATABASE_URL)
    throw new Error('GENERATED_PRODUCTION_ENV_REQUIRED');
  await migrate(values.GOTIT_MIGRATION_DATABASE_URL, 'up');
  const verified = await preflight(values.GOTIT_RUNTIME_EXTERNAL_DATABASE_URL);
  return { migration: 'up', preflight: verified };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  migrateProvisioned(process.argv[2])
    .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch((error) => {
      const safe = [
        'MIGRATION_CONFIRMATION_REQUIRED',
        'GENERATED_PRODUCTION_ENV_REQUIRED',
      ].includes(error?.message)
        ? error.message
        : 'PROVISIONED_MIGRATION_FAILED';
      process.stderr.write(`${safe}\n`);
      process.exitCode = 1;
    });
}
