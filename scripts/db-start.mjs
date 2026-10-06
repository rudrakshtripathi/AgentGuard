#!/usr/bin/env node
// Starts a real, local PostgreSQL 17 server (via the `embedded-postgres` npm
// package) for development and testing when Supabase / Docker / a system
// Postgres is not available. It binds to 127.0.0.1 only and keeps its data in
// ./.data/postgres. Leave this process running; Ctrl+C stops the server.
//
// If you use Supabase or your own Postgres instead, you do not need this
// script — just point DATABASE_URL / DATABASE_ADMIN_URL at that server.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv, rootDir } from './lib/env.mjs';

loadEnv();

const port = Number(process.env.EMBEDDED_PG_PORT ?? 54329);
const user = process.env.EMBEDDED_PG_USER ?? 'postgres';
const password = process.env.EMBEDDED_PG_PASSWORD ?? 'postgres';
const databaseDir = resolve(rootDir, '.data', 'postgres');
const databases = ['agentguard', 'agentguard_test', 'agentguard_e2e'];

const pg = new EmbeddedPostgres({
  databaseDir,
  user,
  password,
  port,
  persistent: true,
  onLog: () => {},
  onError: (message) => {
    const text = String(message ?? '').trim();
    if (text) console.error(`[postgres] ${text}`);
  },
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1'],
});

async function main() {
  if (!existsSync(resolve(databaseDir, 'PG_VERSION'))) {
    console.log(`[db] initialising new cluster in ${databaseDir}`);
    await pg.initialise();
  }
  await pg.start();
  const client = pg.getPgClient();
  await client.connect();
  for (const name of databases) {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) {
      await pg.createDatabase(name);
      console.log(`[db] created database ${name}`);
    }
  }
  await client.end();
  console.log(`[db] READY postgres://${user}:***@127.0.0.1:${port}/{${databases.join(',')}}`);
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('[db] stopping postgres...');
  try {
    await pg.stop();
  } finally {
    process.exit(0);
  }
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGBREAK', shutdown);

main().catch(async (err) => {
  console.error('[db] failed to start embedded postgres:', err?.message ?? err);
  console.error('[db] If a previous instance is still running, stop it or delete .data/postgres/postmaster.pid.');
  process.exit(1);
});
