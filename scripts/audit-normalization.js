import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
const normalize = (value) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
export async function auditNormalization(client, deadline = Date.now() + 60000) {
  const report = { completed: true, tables: {} };
  for (const [table, display, normalized] of [
    ['learning_items', 'source_text', 'normalized_source_text'],
    ['item_translations', 'translation_text', 'normalized_text'],
    ['tags', 'name', 'normalized_name'],
    ['user_interests', 'name', 'normalized_name'],
  ]) {
    let cursor = null,
      checked = 0,
      mismatches = 0;
    while (Date.now() < deadline) {
      const rows = (
        await client.query(
          `SELECT id,${display} display,${normalized} normalized FROM product_gotit.${table} WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 1000`,
          [cursor],
        )
      ).rows;
      for (const row of rows) {
        checked++;
        if (normalize(row.display) !== row.normalized) mismatches++;
      }
      if (rows.length < 1000) break;
      cursor = rows.at(-1).id;
    }
    if (Date.now() >= deadline) report.completed = false;
    report.tables[table] = { checked, mismatches };
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await import('dotenv/config');
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
    query_timeout: 6000,
  });
  try {
    if (!process.env.DATABASE_URL) throw new Error();
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const report = await auditNormalization(client);
    await client.query('ROLLBACK');
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.completed || Object.values(report.tables).some((t) => t.mismatches))
      process.exitCode = 1;
  } catch {
    process.stderr.write('NORMALIZATION_AUDIT_UNAVAILABLE\n');
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}
