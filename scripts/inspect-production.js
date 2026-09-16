import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { auditNormalization } from './audit-normalization.js';
import { verifyBaseline } from './migrate.js';

/** A remote inspection that cannot write and never prints connection or identity data. */
export async function inspectProduction(databaseUrl) {
  if (!databaseUrl) throw new Error('INSPECTION_DATABASE_URL_REQUIRED');
  const parsed = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol))
    throw new Error('INSPECTION_DATABASE_URL_INVALID');
  const client = new pg.Client({
    connectionString: databaseUrl,
    application_name: 'gotit_read_only_inspection',
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 6000,
  });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await verifyBaseline(client);
    const tables = (
      await client.query(
        "SELECT count(*)::integer count FROM information_schema.tables WHERE table_schema='product_gotit' AND table_type='BASE TABLE'",
      )
    ).rows[0].count;
    const columns = (
      await client.query(
        `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='product_gotit' AND table_name='learning_items' AND column_name='learning_revision') learning_revision,
        EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='product_gotit' AND table_name='item_occurrences' AND column_name='capture_receipt') capture_receipts,
        to_regclass('product_gotit.practice_exercises') IS NOT NULL practice_exercises,
        to_regclass('product_gotit.api_rate_limits') IS NOT NULL api_rate_limits`,
      )
    ).rows[0];
    const role = (
      await client.query(
        `SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls,
        has_database_privilege(current_user,current_database(),'CREATE') database_create,
        has_schema_privilege(current_user,'product_gotit','CREATE') product_schema_create,
        EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='core' AND c.relkind IN('r','v','m') AND has_table_privilege(current_user,c.oid,'SELECT,INSERT,UPDATE,DELETE')) core_table_access
        FROM pg_roles WHERE rolname=current_user`,
      )
    ).rows[0];
    const duplicateAttemptSequences = (
      await client.query(
        `SELECT count(*)::integer count FROM(SELECT 1 FROM product_gotit.practice_attempts GROUP BY application_id,application_user_id,practice_session_id,attempt_sequence HAVING count(*)>1) duplicate_groups`,
      )
    ).rows[0].count;
    const normalization = await auditNormalization(client, Date.now() + 45000);
    await client.query('ROLLBACK');
    return {
      baseline: 'ok',
      productTableCount: tables,
      v1: {
        learningRevision: columns.learning_revision,
        captureReceipts: columns.capture_receipts,
        practiceExercises: columns.practice_exercises,
        apiRateLimits: columns.api_rate_limits,
      },
      role: {
        superuser: role.rolsuper,
        createDatabase: role.rolcreatedb || role.database_create,
        createRole: role.rolcreaterole,
        replication: role.rolreplication,
        bypassRls: role.rolbypassrls,
        productSchemaCreate: role.product_schema_create,
        coreTableAccess: role.core_table_access,
      },
      conflicts: { duplicateAttemptSequenceGroups: duplicateAttemptSequences },
      normalization,
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* Preserve the inspection failure. */
    }
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await import('dotenv/config');
  inspectProduction(process.env.GOTIT_INSPECTION_DATABASE_URL)
    .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch((error) => {
      const code =
        error instanceof Error &&
        /^INSPECTION_DATABASE_URL_(REQUIRED|INVALID)$/u.test(error.message)
          ? error.message
          : 'PRODUCTION_INSPECTION_UNAVAILABLE';
      process.stderr.write(`${code}\n`);
      process.exitCode = 1;
    });
}
