import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { verifyBaseline } from './migrate.js';

/** Read-only production gate. Results never include connections, identities or data. */
export async function verifyRuntimeSchema(client, { strictRole = true } = {}) {
  await verifyBaseline(client);
  const requirements = {
    item_occurrences: ['capture_request_hash', 'capture_receipt', 'learning_revision'],
    item_examples: ['learning_revision'],
    learning_items: ['learning_revision'],
    item_translations: ['is_current'],
    user_profiles: ['learning_preferences', 'default_source_language'],
    practice_sessions: ['selection', 'client_event_id', 'request_hash', 'response_receipt'],
    practice_attempts: ['request_hash', 'response_receipt', 'learning_revision'],
    generated_contents: ['request_hash', 'publication_receipt'],
    practice_exercises: [
      'id',
      'application_id',
      'application_user_id',
      'practice_session_id',
      'learning_item_id',
      'answer_spec',
      'item_snapshot_hash',
      'expires_at',
      'consumed_at',
    ],
    api_rate_limits: ['bucket_key', 'window_start', 'request_count', 'expires_at'],
    ai_monthly_usage: [
      'application_id',
      'application_user_id',
      'usage_month',
      'generation_count',
      'updated_at',
    ],
  };
  const columns = (
    await client.query(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='product_gotit'",
    )
  ).rows;
  if (
    !Object.entries(requirements).every(([table, fields]) =>
      fields.every((field) =>
        columns.some((c) => c.table_name === table && c.column_name === field),
      ),
    )
  )
    throw new Error('GOTIT_SCHEMA_MIGRATIONS_REQUIRED');
  const indexes = (
    await client.query(
      `SELECT c.relname,pg_get_indexdef(c.oid) definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_index i ON i.indexrelid=c.oid WHERE n.nspname='product_gotit' AND i.indisvalid AND i.indisready AND i.indisunique`,
    )
  ).rows;
  for (const [name, definition] of Object.entries({
    practice_sessions_client_event_idx: '(application_id, application_user_id, client_event_id)',
    practice_attempts_unique_sequence_idx:
      '(application_id, application_user_id, practice_session_id, attempt_sequence)',
    practice_attempts_client_event_idx: '(application_id, application_user_id, client_event_id)',
    xp_events_idempotency_idx: '(application_id, application_user_id, idempotency_key)',
  })) {
    if (!indexes.some((i) => i.relname === name && i.definition.includes(definition)))
      throw new Error('GOTIT_REQUIRED_UNIQUE_INDEX_MISSING');
  }
  const constraints = (
    await client.query(
      "SELECT conname,convalidated,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE connamespace='product_gotit'::regnamespace",
    )
  ).rows;
  for (const name of ['practice_exercises_session_fkey', 'practice_exercises_learning_item_fkey']) {
    const constraint = constraints.find((c) => c.conname === name);
    if (
      !constraint?.convalidated ||
      !constraint.definition.includes('FOREIGN KEY (application_id, application_user_id,')
    )
      throw new Error('GOTIT_EXERCISE_SCOPE_CONSTRAINT_MISSING');
  }
  const grants = (
    await client.query(
      `SELECT c.relname,has_table_privilege(current_user,c.oid,'SELECT') AS read,has_table_privilege(current_user,c.oid,'INSERT') AS insert,has_table_privilege(current_user,c.oid,'UPDATE') AS update,has_table_privilege(current_user,c.oid,'DELETE') AS delete FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='product_gotit' AND c.relkind='r'`,
    )
  ).rows;
  if (!grants.every((g) => g.read && g.insert && g.update && g.delete))
    throw new Error('GOTIT_RUNTIME_GRANTS_REQUIRED');
  if (strictRole) {
    const role = (
      await client.query(
        `SELECT r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolbypassrls,r.rolreplication,has_schema_privilege(current_user,'product_gotit','CREATE') can_create,has_database_privilege(current_user,current_database(),'CREATE') database_create,EXISTS(SELECT 1 FROM pg_roles other WHERE other.oid<>r.oid AND pg_has_role(current_user,other.oid,'MEMBER')) role_membership,EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='core' AND p.prosecdef AND has_function_privilege(current_user,p.oid,'EXECUTE')) core_functions,EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='core' AND c.relkind IN('r','v','m') AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE')) core_access FROM pg_roles r WHERE r.rolname=current_user`,
      )
    ).rows[0];
    if (
      !role ||
      role.rolsuper ||
      role.rolcreatedb ||
      role.rolcreaterole ||
      role.rolbypassrls ||
      role.rolreplication ||
      role.database_create ||
      role.role_membership ||
      role.core_functions ||
      role.can_create ||
      role.core_access
    )
      throw new Error('GOTIT_DEDICATED_RUNTIME_ROLE_REQUIRED');
  }
  return {
    schema: 'ok',
    privileges: 'ok',
    role: strictRole ? 'product-only' : 'not-enforced',
    operationalTables: 3,
  };
}

export async function preflight(databaseUrl) {
  if (!databaseUrl) throw new Error('DATABASE_URL_REQUIRED');
  const client = new pg.Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
    query_timeout: 6000,
  });
  await client.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await verifyRuntimeSchema(client);
    await client.query('ROLLBACK');
    return result;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await import('dotenv/config');
  preflight(process.env.DATABASE_URL)
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      const code =
        error instanceof Error && /^GOTIT_[A-Z_]+$|^DATABASE_URL_REQUIRED$/u.test(error.message)
          ? error.message
          : 'PREFLIGHT_DATABASE_UNAVAILABLE';
      process.stderr.write(`${code}\n`);
      process.exitCode = 1;
    });
}
