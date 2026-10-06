import pg from 'pg';
import { dropAll } from '../../src/db/reset.js';
import { migrate } from '../../src/db/migrate.js';
import { opaUrl, requireUrls } from './env.js';

/** Recreates the test schema once per run and fails fast if Postgres or OPA is down. */
export default async function setup() {
  const { admin, app } = requireUrls();
  const probe = new pg.Client({ connectionString: admin, connectionTimeoutMillis: 3000 });
  try {
    await probe.connect();
  } catch (err) {
    throw new Error(`Cannot reach the test database (${(err as Error).message}). Start Postgres: \`npm run db:start\`.`, { cause: err });
  } finally {
    await probe.end().catch(() => {});
  }
  const res = await fetch(`${opaUrl}/v1/data/agentguard/policy/result`, { method: 'POST', body: '{"input":{}}' }).catch(() => null);
  if (!res?.ok) throw new Error(`OPA is not reachable at ${opaUrl}. Start it: \`npm run opa:start\`.`);
  await dropAll(admin);
  await migrate(admin, app);
}
