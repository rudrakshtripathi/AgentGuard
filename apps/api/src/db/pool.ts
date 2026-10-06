import pg from 'pg';

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;
/** Anything that can run a parameterised query (pool or checked-out client). */
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

// numeric(5,2) columns come back as strings by default; scores are small, so a JS number is exact enough.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => Number.parseFloat(value));
// bigint (audit_log.seq, COUNT(*)) fits comfortably in a JS number at this project's scale.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number.parseInt(value, 10));

export function createPool(connectionString: string, max = 10): Db {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 5000 });
  // An idle client erroring (e.g. DB restart) must not crash the process.
  pool.on('error', () => {});
  return pool;
}

export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
