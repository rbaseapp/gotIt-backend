import pg from 'pg';

export function createPool(databaseUrl: string) {
  return new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 3000,
    statement_timeout: 5000,
    query_timeout: 6000,
  });
}

export type DatabasePool = ReturnType<typeof createPool>;
