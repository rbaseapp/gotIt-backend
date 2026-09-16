import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

const connection = (source, role, password, internal) => {
  const url = new URL(source);
  url.username = role;
  url.password = password;
  if (internal) {
    url.hostname = url.hostname.split('.')[0];
    url.search = '';
  } else {
    url.searchParams.set('sslmode', 'verify-full');
  }
  return url.toString();
};

export async function provisionProduction(databaseUrl, confirmation) {
  if (confirmation !== 'product-only-v1') throw new Error('PROVISION_CONFIRMATION_REQUIRED');
  if (!databaseUrl) throw new Error('INSPECTION_DATABASE_URL_REQUIRED');
  const runtimePassword = randomBytes(32).toString('base64url');
  const migratorPassword = randomBytes(32).toString('base64url');
  const client = new pg.Client({
    connectionString: databaseUrl,
    application_name: 'gotit_role_provisioning',
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    query_timeout: 20000,
  });
  await client.connect();
  try {
    const roles = await client.query(
      "SELECT to_regrole('gotit_runtime') IS NOT NULL runtime,to_regrole('gotit_migrator') IS NOT NULL migrator",
    );
    if (roles.rows[0].runtime || roles.rows[0].migrator)
      throw new Error('GOTIT_ROLES_ALREADY_EXIST');
    const runtimeSql = await readFile(resolve('scripts/provision-runtime.sql'), 'utf8');
    const migratorSql = await readFile(resolve('scripts/provision-migrator.sql'), 'utf8');
    await client.query('BEGIN');
    await client.query(runtimeSql);
    await client.query(`ALTER ROLE gotit_runtime PASSWORD ${pg.escapeLiteral(runtimePassword)}`);
    await client.query(migratorSql);
    await client.query(`ALTER ROLE gotit_migrator PASSWORD ${pg.escapeLiteral(migratorPassword)}`);
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* Preserve the provisioning failure. */
    }
    throw error;
  } finally {
    await client.end();
  }
  const values = {
    GOTIT_RUNTIME_INTERNAL_DATABASE_URL: connection(
      databaseUrl,
      'gotit_runtime',
      runtimePassword,
      true,
    ),
    GOTIT_RUNTIME_EXTERNAL_DATABASE_URL: connection(
      databaseUrl,
      'gotit_runtime',
      runtimePassword,
      false,
    ),
    GOTIT_MIGRATION_DATABASE_URL: connection(
      databaseUrl,
      'gotit_migrator',
      migratorPassword,
      false,
    ),
    GOTIT_MIGRATOR_INTERNAL_DATABASE_URL: connection(
      databaseUrl,
      'gotit_migrator',
      migratorPassword,
      true,
    ),
  };
  const serialized = Object.entries(values)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join('\n');
  await writeFile(resolve('.env.production.generated'), `${serialized}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return { runtimeRole: 'created', migratorRole: 'created', generatedEnvironment: 'written' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await import('dotenv/config');
  provisionProduction(process.env.GOTIT_INSPECTION_DATABASE_URL, process.argv[2])
    .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch((error) => {
      const safe = ['PROVISION_CONFIRMATION_REQUIRED', 'GOTIT_ROLES_ALREADY_EXIST'].includes(
        error?.message,
      )
        ? error.message
        : 'PRODUCTION_PROVISIONING_FAILED';
      process.stderr.write(`${safe}\n`);
      process.exitCode = 1;
    });
}
