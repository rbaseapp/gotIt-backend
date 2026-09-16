import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryConfig, QueryResultRow } from 'pg';
import { AppError } from '../errors/app-error.js';

const config = (
  text: string,
  values: unknown[],
  timeout: number,
): QueryConfig & { query_timeout: number } => ({ text, values, query_timeout: timeout });
export class DatabaseTransaction {
  private readonly deadline = Date.now() + 15000;
  constructor(readonly client: PoolClient) {}
  async query<T extends QueryResultRow = QueryResultRow>(text: string, values: unknown[] = []) {
    const budget = Math.min(5000, this.deadline - Date.now());
    if (budget <= 0)
      throw new AppError(503, 'DATABASE_UNAVAILABLE', 'Database transaction deadline exceeded');
    await this.client.query(
      config(
        "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
        [`${budget}ms`, `${Math.min(3000, budget)}ms`],
        budget,
      ),
    );
    const remaining = Math.min(budget, this.deadline - Date.now());
    if (remaining <= 0)
      throw new AppError(503, 'DATABASE_UNAVAILABLE', 'Database transaction deadline exceeded');
    return this.client.query<T>(config(text, values, remaining));
  }
  async lock(parts: string[]) {
    const hash = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
    await this.query('SELECT pg_advisory_xact_lock($1::bigint)', [
      BigInt.asIntN(64, BigInt(`0x${hash}`)).toString(),
    ]);
  }
}
export async function withTransaction<T>(
  pool: Pool,
  operation: (tx: DatabaseTransaction) => Promise<T>,
  readOnly = false,
): Promise<T> {
  let client: PoolClient | undefined,
    destroy = false,
    timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    client = await Promise.race([
      pool.connect().then((c) => {
        if (timedOut) {
          c.release();
          throw new Error('Pool deadline');
        }
        return c;
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('Pool deadline'));
        }, 3000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    await client.query(
      config(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN', [], 3000),
    );
    const tx = new DatabaseTransaction(client),
      result = await operation(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    if (client)
      try {
        await client.query(config('ROLLBACK', [], 1000));
      } catch {
        destroy = true;
      }
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'DATABASE_UNAVAILABLE', 'Database is temporarily unavailable');
  } finally {
    if (timer) clearTimeout(timer);
    client?.release(destroy);
  }
}
