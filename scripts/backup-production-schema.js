import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
const run = promisify(execFile);

export async function backupProductionSchema(databaseUrl) {
  if (!databaseUrl) throw new Error('INSPECTION_DATABASE_URL_REQUIRED');
  const parsed = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol))
    throw new Error('INSPECTION_DATABASE_URL_INVALID');
  const directory = resolve('.local-backups');
  await mkdir(directory, { recursive: true });
  const filename = `gotit-schema-before-v1-${new Date().toISOString().replace(/[:.]/gu, '-')}.dump`;
  await run(
    'docker',
    [
      'run',
      '--rm',
      '--env',
      'PGPASSWORD',
      '--env',
      'PGSSLMODE=verify-full',
      '--env',
      'PGSSLROOTCERT=system',
      '--volume',
      `${directory}:/backup`,
      'postgres:17-alpine',
      'pg_dump',
      '--host',
      parsed.hostname,
      '--username',
      decodeURIComponent(parsed.username),
      '--dbname',
      parsed.pathname.slice(1),
      '--schema',
      'product_gotit',
      '--schema-only',
      '--format',
      'custom',
      '--no-owner',
      '--file',
      `/backup/${filename}`,
    ],
    {
      env: { ...process.env, PGPASSWORD: decodeURIComponent(parsed.password) },
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    },
  );
  const content = await readFile(resolve(directory, filename));
  return {
    filename,
    bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await import('dotenv/config');
  backupProductionSchema(process.env.GOTIT_INSPECTION_DATABASE_URL)
    .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch(() => {
      process.stderr.write('PRODUCTION_SCHEMA_BACKUP_FAILED\n');
      process.exitCode = 1;
    });
}
