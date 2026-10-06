import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import pg from 'pg';

/**
 * CONTROLLED TAMPER TOOL — demo/test only (Implementation Plan §8 scenario 5: "edit a row
 * directly in Postgres, run the verifier, show it catch the change").
 *
 * This is deliberately NOT part of the application: the server never imports it, it needs
 * the database OWNER connection (DATABASE_ADMIN_URL), and it must temporarily disable the
 * append-only trigger to modify a row — exactly what an attacker with DB access would do.
 * The application role cannot do any of this (no UPDATE/DELETE grant on audit_log).
 * The original row is backed up so `restore` returns the chain to a valid state.
 */

export type TamperMode = 'payload' | 'hash' | 'prev_hash' | 'delete';

interface BackupRow {
  id: string;
  seq: number;
  event_type: string;
  payload_json: unknown;
  prev_hash: string | null;
  hash: string;
  created_at: string;
}
interface Backup {
  mode: TamperMode;
  row: BackupRow;
}

const TRIGGERS = ['trg_audit_log_no_update', 'trg_audit_log_no_delete'];

async function withTriggersDisabled<T>(client: pg.Client, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    for (const t of TRIGGERS) await client.query(`ALTER TABLE audit_log DISABLE TRIGGER ${t}`);
    const out = await fn();
    for (const t of TRIGGERS) await client.query(`ALTER TABLE audit_log ENABLE TRIGGER ${t}`);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

/** Picks the most recent decision_made row (flipping a decision is the most telling tamper). */
async function pickTarget(client: pg.Client, seq?: number): Promise<BackupRow> {
  const r = seq
    ? await client.query<BackupRow>('SELECT id, seq, event_type, payload_json, prev_hash, hash, created_at FROM audit_log WHERE seq = $1', [seq])
    : await client.query<BackupRow>(
        `SELECT id, seq, event_type, payload_json, prev_hash, hash, created_at FROM audit_log
          WHERE seq < (SELECT max(seq) FROM audit_log)
          ORDER BY (event_type = 'decision_made') DESC, seq DESC LIMIT 1`,
      );
  const row = r.rows[0];
  if (!row) throw new Error(seq ? `No audit row with seq ${seq}.` : 'Audit log needs at least 2 rows to tamper with.');
  return { ...row, created_at: new Date(row.created_at).toISOString() };
}

export async function tamper(adminUrl: string, backupFile: string, mode: TamperMode = 'payload', seq?: number) {
  if (existsSync(backupFile)) throw new Error(`A tamper is already active (${backupFile}). Run restore first.`);
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const row = await pickTarget(client, seq);
    let description: string;
    await withTriggersDisabled(client, async () => {
      if (mode === 'payload') {
        const payload = { ...(row.payload_json as Record<string, unknown>) };
        if (typeof payload.decision === 'string') {
          payload.decision = payload.decision === 'allow' ? 'block' : 'allow';
          description = `changed decision to "${String(payload.decision)}"`;
        } else {
          payload.tampered = true;
          description = 'added a "tampered" field to the payload';
        }
        await client.query('UPDATE audit_log SET payload_json = $2 WHERE id = $1', [row.id, payload]);
      } else if (mode === 'hash') {
        await client.query('UPDATE audit_log SET hash = $2 WHERE id = $1', [row.id, 'f'.repeat(64)]);
        description = 'overwrote the stored hash';
      } else if (mode === 'prev_hash') {
        if (row.seq === 1) throw new Error('The genesis row has no prev_hash; choose another --seq.');
        await client.query('UPDATE audit_log SET prev_hash = $2 WHERE id = $1', [row.id, 'e'.repeat(64)]);
        description = 'overwrote prev_hash (broke the link)';
      } else {
        await client.query('DELETE FROM audit_log WHERE id = $1', [row.id]);
        description = 'deleted the row';
      }
    });
    mkdirSync(dirname(backupFile), { recursive: true });
    writeFileSync(backupFile, JSON.stringify({ mode, row } satisfies Backup, null, 2));
    return { seq: row.seq, id: row.id, event_type: row.event_type, mode, description: description! };
  } finally {
    await client.end();
  }
}

export async function restore(adminUrl: string, backupFile: string) {
  if (!existsSync(backupFile)) throw new Error('No active tamper to restore.');
  const { mode, row } = JSON.parse(readFileSync(backupFile, 'utf8')) as Backup;
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await withTriggersDisabled(client, async () => {
      if (mode === 'delete') {
        await client.query(
          'INSERT INTO audit_log (id, seq, event_type, payload_json, prev_hash, hash, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [row.id, row.seq, row.event_type, row.payload_json, row.prev_hash, row.hash, row.created_at],
        );
      } else {
        await client.query('UPDATE audit_log SET payload_json = $2, prev_hash = $3, hash = $4 WHERE id = $1', [
          row.id,
          row.payload_json,
          row.prev_hash,
          row.hash,
        ]);
      }
    });
    rmSync(backupFile);
    return { seq: row.seq, mode };
  } finally {
    await client.end();
  }
}
