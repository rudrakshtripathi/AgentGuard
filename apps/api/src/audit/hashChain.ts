import { createHash } from 'node:crypto';

/**
 * Hash-chain primitives for the tamper-evident audit log (FR-009, FR-011).
 *
 *   hash_n = SHA-256( canonical_json({ seq, event_type, payload, created_at, prev_hash }) )
 *
 * where prev_hash is the previous row's hash, or GENESIS_PREV_HASH for row 1
 * (stored as NULL in the database). This extends the plan's
 * SHA256(event_type + payload + prev_hash) by also binding the chain position and
 * timestamp, so reordering or re-dating a row is detected too. Canonical JSON (sorted
 * keys, no whitespace) removes the ambiguity of plain string concatenation.
 */

export const GENESIS_PREV_HASH = '0'.repeat(64);

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Deterministic JSON: object keys sorted by code point, no insignificant whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    if (value === undefined) return 'null';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export interface ChainRecord {
  seq: number;
  event_type: string;
  payload: Json;
  created_at: string; // ISO-8601, millisecond precision, UTC
  prev_hash: string | null; // null only for the genesis row
}

export function computeHash(record: ChainRecord): string {
  const material = canonicalJson({
    seq: record.seq,
    event_type: record.event_type,
    payload: record.payload,
    created_at: record.created_at,
    prev_hash: record.prev_hash ?? GENESIS_PREV_HASH,
  });
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

export interface StoredRow extends ChainRecord {
  id: string;
  hash: string;
}

export type BreakReason =
  | 'missing_rows' // gap in seq: one or more rows were deleted
  | 'bad_genesis' // first row is not a genesis row
  | 'prev_hash_mismatch' // link to previous row is broken
  | 'hash_mismatch'; // row contents no longer match its stored hash

export interface VerifyResult {
  valid: boolean;
  status: 'empty' | 'valid' | 'tampered';
  total_rows: number;
  verified_rows: number;
  broken_row_id: string | null;
  broken_seq: number | null;
  reason: BreakReason | null;
  message: string;
}

const describe: Record<BreakReason, string> = {
  missing_rows: 'Chain position gap: one or more rows before this one were deleted.',
  bad_genesis: 'The first row is not a valid genesis row (prev_hash must be empty and seq must be 1).',
  prev_hash_mismatch: "prev_hash does not match the previous row's hash: the chain link was altered or a row was removed.",
  hash_mismatch: "Row contents no longer match the stored hash: the row's data or hash was modified.",
};

/**
 * Walks rows in chain order (ascending seq) and returns the FIRST break found.
 * Rows before the break are counted as verified.
 */
export function verifyChain(rows: readonly StoredRow[]): VerifyResult {
  if (rows.length === 0) {
    return {
      valid: true,
      status: 'empty',
      total_rows: 0,
      verified_rows: 0,
      broken_row_id: null,
      broken_seq: null,
      reason: null,
      message: 'Nothing to verify: the audit log is empty.',
    };
  }
  let previous: StoredRow | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    let reason: BreakReason | null = null;
    if (previous === null) {
      if (row.seq !== 1 || row.prev_hash !== null) reason = row.seq !== 1 ? 'missing_rows' : 'bad_genesis';
    } else if (row.seq !== previous.seq + 1) {
      reason = 'missing_rows';
    } else if (row.prev_hash !== previous.hash) {
      reason = 'prev_hash_mismatch';
    }
    if (!reason && computeHash(row) !== row.hash) reason = 'hash_mismatch';
    if (reason) {
      return {
        valid: false,
        status: 'tampered',
        total_rows: rows.length,
        verified_rows: i,
        broken_row_id: row.id,
        broken_seq: row.seq,
        reason,
        message: `Integrity check failed at row #${row.seq}: ${describe[reason]}`,
      };
    }
    previous = row;
  }
  return {
    valid: true,
    status: 'valid',
    total_rows: rows.length,
    verified_rows: rows.length,
    broken_row_id: null,
    broken_seq: null,
    reason: null,
    message: `Chain valid: all ${rows.length} rows verified.`,
  };
}
