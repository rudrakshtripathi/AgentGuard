import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { repoRoot } from '../config.js';

export const migrationsDir = resolve(repoRoot, 'db', 'migrations');

/** Tables the application role may read. */
const APP_TABLES = ['agents', 'admins', 'admin_sessions', 'tool_calls', 'risk_scores', 'policy_decisions', 'approvals', 'audit_log'];
/** Tables the application role may INSERT into (agents/admins are provisioned by the seed only). */
const APP_INSERT_TABLES = ['admin_sessions', 'tool_calls', 'risk_scores', 'policy_decisions', 'approvals', 'audit_log'];

export interface MigrateResult {
  applied: string[];
  appRole: { name: string; privileged: boolean } | null;
}

function credentials(url: string) {
  const u = new URL(url);
  return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
}

/**
 * Applies pending forward-only SQL migrations (db/migrations/NNN_*.sql) as the owner
 * role, then provisions the least-privilege application role named in DATABASE_URL:
 *   - SELECT on all AgentGuard tables
 *   - INSERT only where the app creates rows
 *   - UPDATE only on approvals(status, reviewer_id, resolved_at) and admin_sessions(revoked_at)
 *   - no UPDATE / DELETE / TRUNCATE anywhere, in particular never on audit_log (TRD §7, FR-010)
 */
export async function migrate(adminUrl: string, appUrl?: string): Promise<MigrateResult> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = readdirSync(migrationsDir)
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(resolve(migrationsDir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }

    let appRole: MigrateResult['appRole'] = null;
    if (appUrl) {
      const app = credentials(appUrl);
      const admin = credentials(adminUrl);
      if (app.user === admin.user) {
        appRole = { name: app.user, privileged: true };
      } else {
        await provisionAppRole(client, app.user, app.password);
        appRole = { name: app.user, privileged: false };
      }
    }
    return { applied, appRole };
  } finally {
    await client.end();
  }
}

async function provisionAppRole(client: pg.Client, user: string, password: string) {
  const role = client.escapeIdentifier(user);
  const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [user]);
  const pw = password ? ` PASSWORD ${client.escapeLiteral(password)}` : '';
  if (!exists.rowCount) {
    await client.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE${pw}`);
  } else if (pw) {
    await client.query(`ALTER ROLE ${role} WITH LOGIN${pw}`);
  }
  const db = (await client.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db;
  await client.query(`GRANT CONNECT ON DATABASE ${client.escapeIdentifier(db)} TO ${role}`);
  await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
  const all = APP_TABLES.join(', ');
  // Start from nothing, then grant exactly what the application needs.
  await client.query(`REVOKE ALL ON ${all} FROM ${role}`);
  await client.query(`REVOKE ALL ON schema_migrations FROM ${role}`);
  await client.query(`GRANT SELECT ON ${all} TO ${role}`);
  await client.query(`GRANT INSERT ON ${APP_INSERT_TABLES.join(', ')} TO ${role}`);
  await client.query(`GRANT UPDATE (status, reviewer_id, resolved_at) ON approvals TO ${role}`);
  await client.query(`GRANT UPDATE (revoked_at) ON admin_sessions TO ${role}`);
}
