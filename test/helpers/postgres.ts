import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';

const run = promisify(execFile);

/** Creates only disposable local infrastructure; never consumes DATABASE_URL. */
export async function createTestDatabase() {
  const corePath = process.env.CORE_PLATFORM_PATH
    ? resolve(process.env.CORE_PLATFORM_PATH)
    : resolve(dirname(fileURLToPath(import.meta.url)), '../../../core-platform');
  const migrationCli = resolve(corePath, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');
  await access(migrationCli).catch(() => {
    throw new Error(
      'Integration bootstrap requires the Core checkout and its installed node-pg-migrate. Set CORE_PLATFORM_PATH if it is not a sibling repository.',
    );
  });

  const containerName = `gotit-profile-test-${randomUUID()}`;
  let containerCreated = false;
  let adminPool: pg.Pool | undefined;
  let runtimePool: pg.Pool | undefined;

  async function dispose() {
    try {
      await runtimePool?.end();
    } finally {
      try {
        await adminPool?.end();
      } finally {
        if (containerCreated) {
          // This name is generated per run and refers only to the container we created.
          await run('docker', ['stop', '--time', '1', containerName], { timeout: 20_000 });
        }
      }
    }
  }

  try {
    await run(
      'docker',
      [
        'run',
        '--detach',
        '--rm',
        '--name',
        containerName,
        '--label',
        'gotit.purpose=profile-integration-test',
        '--publish',
        '127.0.0.1::5432',
        '--env',
        'POSTGRES_HOST_AUTH_METHOD=trust',
        '--env',
        'POSTGRES_DB=gotit_profile_test',
        '--tmpfs',
        '/var/lib/postgresql/data',
        'postgres:17-alpine',
      ],
      { timeout: 90_000 },
    );
    containerCreated = true;

    const { stdout } = await run('docker', ['port', containerName, '5432/tcp']);
    const port = /^127\.0\.0\.1:(\d+)\s*$/.exec(stdout)?.[1];
    if (!port) throw new Error('Test PostgreSQL must be published only on loopback');

    const adminUrl = `postgresql://postgres@127.0.0.1:${port}/gotit_profile_test`;
    adminPool = new pg.Pool({ connectionString: adminUrl, connectionTimeoutMillis: 1000 });
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        await adminPool.query('SELECT 1');
        ready = true;
        break;
      } catch {
        await delay(200);
      }
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not become ready');

    // Run the existing migration tool against this NEW database only. No copying
    // of migration files or changes to production migration ownership occur.
    await run(
      process.execPath,
      [
        migrationCli,
        'up',
        '--migrations-dir',
        resolve(corePath, 'migrations'),
        '--database-url-var',
        'GOTIT_TEST_BOOTSTRAP_URL',
      ],
      {
        cwd: corePath,
        env: { ...process.env, GOTIT_TEST_BOOTSTRAP_URL: adminUrl },
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );

    const gotitPath = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const migrate = async (direction: 'up' | 'down' = 'up') => {
      await run(process.execPath, [resolve(gotitPath, 'scripts/migrate.js'), direction], {
        cwd: gotitPath,
        env: { ...process.env, GOTIT_MIGRATION_DATABASE_URL: adminUrl },
        timeout: 30000,
        maxBuffer: 2 * 1024 * 1024,
      });
    };
    await migrate();

    await adminPool.query(`
      CREATE ROLE gotit_test_runtime LOGIN;
      GRANT USAGE ON SCHEMA product_gotit TO gotit_test_runtime;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA product_gotit TO gotit_test_runtime;
    `);
    runtimePool = new pg.Pool({
      connectionString: adminUrl.replace('://postgres@', '://gotit_test_runtime@'),
      connectionTimeoutMillis: 1000,
    });
    return { adminPool, runtimePool, dispose, migrate };
  } catch (error) {
    try {
      await dispose();
    } catch {
      /* Preserve the setup failure. */
    }
    throw error;
  }
}
