import type { Db, DbClient, Queryable } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import type { Json, StoredRow, VerifyResult } from './hashChain.js';
import { computeHash, verifyChain } from './hashChain.js';

/**
 * Append-only access to the hash-chained audit_log table.
 * There is intentionally NO update or delete function in this module (FR-010), and the
 * application DB role has no UPDATE/DELETE grant on the table either.
 */

export type AuditEventType =
  | 'call_received'
  | 'request_rejected'
  | 'score_computed'
  | 'decision_made'
  | 'approval_requested'
  | 'approval_resolved'
  | 'tool_executed'
  | 'tool_not_executed'
  | 'admin_login'
  | 'admin_login_failed'
  | 'admin_logout'
  | 'demo_scenario_triggered';

export interface AuditEvent {
  event_type: AuditEventType;
  payload: Record<string, unknown>;
  /** Override timestamp — used only by the seed script to write historical events. */
  at?: Date;
}

export interface AuditRow {
  id: string;
  seq: number;
  event_type: string;
  payload_json: Record<string, Json>;
  prev_hash: string | null;
  hash: string;
  referenced_call_id: string | null;
  created_at: string;
}

// Arbitrary constant key for the advisory lock that serialises chain appends (FR-009).
const CHAIN_LOCK_KEY = 4_242_001;

/** Serialises audit appends: held until the surrounding transaction ends. */
export async function lockChain(client: Queryable): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock($1)', [CHAIN_LOCK_KEY]);
}

/** A transaction that may append audit rows. Takes the chain lock first so lock order is uniform. */
export function withAuditTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  return withTransaction(db, async (client) => {
    await lockChain(client);
    return fn(client);
  });
}

/**
 * Appends one event to the chain. MUST run inside a transaction (see withAuditTransaction);
 * the advisory lock guarantees no two rows ever claim the same previous hash.
 */
export async function appendAudit(client: DbClient, event: AuditEvent): Promise<AuditRow> {
  await lockChain(client);
  // Normalise to plain JSON so the hashed value is exactly what jsonb will store.
  const payload = JSON.parse(JSON.stringify(event.payload)) as Record<string, Json>;
  const last = await client.query<{ seq: number; hash: string; created_at: Date }>(
    'SELECT seq, hash, created_at FROM audit_log ORDER BY seq DESC LIMIT 1',
  );
  const prev = last.rows[0];
  const seq = prev ? prev.seq + 1 : 1;
  let at = event.at ?? new Date();
  // Keep timestamps monotonic along the chain even if the wall clock steps backwards.
  if (prev && at.getTime() < prev.created_at.getTime()) at = new Date(prev.created_at.getTime());
  const created_at = at.toISOString();
  const prev_hash = prev ? prev.hash : null;
  const hash = computeHash({ seq, event_type: event.event_type, payload, created_at, prev_hash });
  const inserted = await client.query<AuditRow>(
    `INSERT INTO audit_log (seq, event_type, payload_json, prev_hash, hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, seq, event_type, payload_json, prev_hash, hash, referenced_call_id, created_at`,
    [seq, event.event_type, payload, prev_hash, hash, created_at],
  );
  return toAuditRow(inserted.rows[0]!);
}

/** Convenience: append a single event in its own transaction. */
export function recordAudit(db: Db, event: AuditEvent): Promise<AuditRow> {
  return withAuditTransaction(db, (client) => appendAudit(client, event));
}

function toAuditRow(row: AuditRow & { created_at: unknown }): AuditRow {
  const created = row.created_at as unknown;
  return { ...row, created_at: created instanceof Date ? created.toISOString() : String(created) };
}

export interface AuditListQuery {
  page: number;
  pageSize: number;
  eventType?: string;
  callId?: string;
  focusSeq?: number;
}

export interface AuditListResult {
  items: AuditRow[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

/** Newest-first page of audit rows; `focusSeq` jumps to the page containing that row. */
export async function listAudit(db: Queryable, q: AuditListQuery): Promise<AuditListResult> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.eventType) {
    params.push(q.eventType);
    where.push(`event_type = $${params.length}`);
  }
  if (q.callId) {
    params.push(q.callId);
    where.push(`referenced_call_id = $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log ${whereSql}`, params)).rows[0]!.n;
  let page = q.page;
  if (q.focusSeq !== undefined) {
    const before = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log ${whereSql ? `${whereSql} AND` : 'WHERE'} seq > $${params.length + 1}`,
      [...params, q.focusSeq],
    );
    page = Math.floor(before.rows[0]!.n / q.pageSize) + 1;
  }
  const rows = await db.query<AuditRow>(
    `SELECT id, seq, event_type, payload_json, prev_hash, hash, referenced_call_id, created_at
       FROM audit_log ${whereSql}
      ORDER BY seq DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, q.pageSize, (page - 1) * q.pageSize],
  );
  return {
    items: rows.rows.map(toAuditRow),
    page,
    page_size: q.pageSize,
    total,
    total_pages: Math.max(1, Math.ceil(total / q.pageSize)),
  };
}

export async function auditForCall(db: Queryable, callId: string): Promise<AuditRow[]> {
  const rows = await db.query<AuditRow>(
    `SELECT id, seq, event_type, payload_json, prev_hash, hash, referenced_call_id, created_at
       FROM audit_log WHERE referenced_call_id = $1 ORDER BY seq ASC`,
    [callId],
  );
  return rows.rows.map(toAuditRow);
}

/** Reads the whole chain in order and recomputes every hash (FR-011). Read-only. */
export async function verifyAuditLog(db: Queryable): Promise<VerifyResult & { checked_at: string }> {
  const result = await db.query<{
    id: string;
    seq: number;
    event_type: string;
    payload_json: Json;
    prev_hash: string | null;
    hash: string;
    created_at: Date;
  }>('SELECT id, seq, event_type, payload_json, prev_hash, hash, created_at FROM audit_log ORDER BY seq ASC');
  const rows: StoredRow[] = result.rows.map((r) => ({
    id: r.id,
    seq: r.seq,
    event_type: r.event_type,
    payload: r.payload_json,
    prev_hash: r.prev_hash,
    hash: r.hash,
    created_at: r.created_at.toISOString(),
  }));
  return { ...verifyChain(rows), checked_at: new Date().toISOString() };
}
