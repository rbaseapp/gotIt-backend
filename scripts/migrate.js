import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { runner } from 'node-pg-migrate';

export async function verifyBaseline(client) {
  const expected = [
    'user_profiles',
    'user_language_proficiencies',
    'user_interests',
    'learning_items',
    'item_translations',
    'item_occurrences',
    'item_examples',
    'item_skill_progress',
    'practice_sessions',
    'practice_attempts',
    'attempt_skill_effects',
    'enrichment_runs',
    'tags',
    'learning_item_tags',
    'generated_contents',
    'generated_content_items',
    'user_gamification',
    'xp_events',
    'user_daily_activity',
    'learning_algorithm_events',
  ];
  const result = await client.query(`SELECT table_name FROM information_schema.tables
    WHERE table_schema='product_gotit' AND table_type='BASE TABLE'`);
  if (!expected.every((t) => result.rows.some((r) => r.table_name === t)))
    throw new Error('Required GotIt baseline tables are missing');
  const constraints =
    await client.query(`SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE connamespace='product_gotit'::regnamespace`);
  const roots = [
    'user_profiles',
    'user_language_proficiencies',
    'user_interests',
    'learning_items',
    'practice_sessions',
    'enrichment_runs',
    'tags',
    'generated_contents',
    'user_gamification',
    'xp_events',
    'user_daily_activity',
  ];
  for (const table of roots) {
    const constraint = constraints.rows.find((r) => r.conname === `${table}_application_user_fkey`);
    if (
      !constraint?.convalidated ||
      !constraint.definition.includes('FOREIGN KEY (application_id, application_user_id)') ||
      !constraint.definition.includes('REFERENCES core.application_users(application_id, id)')
    ) {
      throw new Error('Required scoped GotIt baseline user foreign key is missing');
    }
  }
  for (const table of [
    'item_translations',
    'item_occurrences',
    'item_examples',
    'item_skill_progress',
    'enrichment_runs',
    'practice_attempts',
    'learning_item_tags',
    'generated_content_items',
    'learning_algorithm_events',
  ]) {
    const constraint = constraints.rows.find((r) => r.conname === `${table}_learning_item_fkey`);
    if (
      !constraint?.convalidated ||
      !constraint.definition.includes(
        'FOREIGN KEY (application_id, application_user_id, learning_item_id)',
      ) ||
      !constraint.definition.includes(
        'REFERENCES product_gotit.learning_items(application_id, application_user_id, id)',
      )
    ) {
      throw new Error('Required scoped GotIt baseline foreign key is missing');
    }
  }
  const index =
    await client.query(`SELECT p.indexdef FROM pg_indexes p JOIN pg_class c ON c.relname=p.indexname
    JOIN pg_namespace n ON n.oid=c.relnamespace AND n.nspname=p.schemaname JOIN pg_index i ON i.indexrelid=c.oid
    WHERE p.schemaname='product_gotit' AND p.indexname='item_occurrences_client_event_idx' AND i.indisvalid AND i.indisready`);
  const definition = index.rows[0]?.indexdef;
  if (
    !definition?.includes('UNIQUE INDEX') ||
    !definition.includes('(application_id, application_user_id, client_event_id)') ||
    !definition.includes('WHERE (client_event_id IS NOT NULL)')
  )
    throw new Error('Required capture uniqueness baseline is missing');
}

/** Explicit administrator connection; never reads runtime DATABASE_URL or .env. */
export async function migrate(databaseUrl, direction = 'up') {
  if (!databaseUrl) throw new Error('GOTIT_MIGRATION_DATABASE_URL is required');
  if (!['up', 'down'].includes(direction))
    throw new Error('Migration direction must be up or down');
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
    query_timeout: 6000,
  });
  await client.connect();
  try {
    await verifyBaseline(client);
    const metadata = await client.query(
      "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='gotit_migrations') AS present",
    );
    if (!metadata.rows[0].present) await client.query('CREATE SCHEMA gotit_migrations');
  } finally {
    await client.end();
  }
  return runner({
    databaseUrl,
    dir: resolve(import.meta.dirname, '../migrations'),
    direction,
    count: direction === 'down' ? 1 : Infinity,
    migrationsSchema: 'gotit_migrations',
    migrationsTable: 'pgmigrations',
    createMigrationsSchema: false,
    checkOrder: true,
    // Use node-pg-migrate's default lock, shared with Core's existing runner.
    log: () => {},
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  migrate(process.env.GOTIT_MIGRATION_DATABASE_URL, process.argv[2] ?? 'up')
    .then(() => process.stdout.write('GotIt migrations completed\n'))
    .catch(() => {
      process.stderr.write(
        'GotIt migration failed; check administrator access and baseline prerequisites\n',
      );
      process.exitCode = 1;
    });
}
