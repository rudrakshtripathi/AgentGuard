import { describe, expect, it } from 'vitest';
import type { StoredRow } from '../../src/audit/hashChain.js';
import { GENESIS_PREV_HASH, canonicalJson, computeHash, verifyChain } from '../../src/audit/hashChain.js';

function buildChain(n: number): StoredRow[] {
  const rows: StoredRow[] = [];
  for (let i = 1; i <= n; i++) {
    const base = {
      seq: i,
      event_type: i % 2 ? 'call_received' : 'decision_made',
      payload: { tool_call_id: `call-${i}`, decision: 'block', n: i },
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
      prev_hash: i === 1 ? null : rows[i - 2]!.hash,
    };
    rows.push({ ...base, id: `row-${i}`, hash: computeHash(base) });
  }
  return rows;
}

describe('canonicalJson', () => {
  it('is independent of key order and has no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe('{"a":{"c":"x","d":[1,2]},"b":1}');
    expect(canonicalJson({ a: { c: 'x', d: [1, 2] }, b: 1 })).toBe(canonicalJson({ b: 1, a: { d: [1, 2], c: 'x' } }));
  });
  it('drops undefined keys like JSON.stringify and keeps array order', () => {
    expect(canonicalJson({ a: undefined, b: [3, 1, 2] })).toBe('{"b":[3,1,2]}');
  });
  it('escapes strings safely', () => {
    expect(canonicalJson({ s: '<script>"\n' })).toBe('{"s":"<script>\\"\\n"}');
  });
});

describe('computeHash', () => {
  const record = { seq: 1, event_type: 'call_received', payload: { a: 1 }, created_at: '2026-01-01T00:00:00.000Z', prev_hash: null };
  it('is deterministic SHA-256 hex', () => {
    expect(computeHash(record)).toMatch(/^[0-9a-f]{64}$/);
    expect(computeHash(record)).toBe(computeHash({ ...record, payload: { a: 1 } }));
  });
  it('changes when any bound field changes', () => {
    const h = computeHash(record);
    expect(computeHash({ ...record, payload: { a: 2 } })).not.toBe(h);
    expect(computeHash({ ...record, event_type: 'decision_made' })).not.toBe(h);
    expect(computeHash({ ...record, seq: 2 })).not.toBe(h);
    expect(computeHash({ ...record, created_at: '2026-01-01T00:00:00.001Z' })).not.toBe(h);
    expect(computeHash({ ...record, prev_hash: 'a'.repeat(64) })).not.toBe(h);
  });
  it('treats a null prev_hash as the genesis constant', () => {
    expect(computeHash(record)).toBe(computeHash({ ...record, prev_hash: GENESIS_PREV_HASH }));
  });
});

describe('verifyChain', () => {
  it('reports an empty log as "nothing to verify", not an error', () => {
    const r = verifyChain([]);
    expect(r).toMatchObject({ valid: true, status: 'empty', total_rows: 0 });
  });

  it('passes an intact chain', () => {
    const r = verifyChain(buildChain(10));
    expect(r).toMatchObject({ valid: true, status: 'valid', verified_rows: 10, broken_row_id: null });
  });

  it('detects a modified payload at exactly that row', () => {
    const rows = buildChain(10);
    rows[4] = { ...rows[4]!, payload: { ...(rows[4]!.payload as object), decision: 'allow' } };
    expect(verifyChain(rows)).toMatchObject({ valid: false, broken_seq: 5, broken_row_id: 'row-5', reason: 'hash_mismatch', verified_rows: 4 });
  });

  it('detects a modified hash', () => {
    const rows = buildChain(6);
    rows[2] = { ...rows[2]!, hash: 'f'.repeat(64) };
    expect(verifyChain(rows)).toMatchObject({ valid: false, broken_seq: 3, reason: 'hash_mismatch' });
  });

  it('detects a recomputed hash because the next link breaks', () => {
    // Attacker edits row 3 AND recomputes its hash: row 4's prev_hash no longer matches.
    const rows = buildChain(6);
    const edited = { ...rows[2]!, payload: { forged: true } };
    rows[2] = { ...edited, hash: computeHash(edited) };
    expect(verifyChain(rows)).toMatchObject({ valid: false, broken_seq: 4, reason: 'prev_hash_mismatch' });
  });

  it('detects a modified prev_hash', () => {
    const rows = buildChain(6);
    rows[3] = { ...rows[3]!, prev_hash: 'e'.repeat(64) };
    expect(verifyChain(rows)).toMatchObject({ valid: false, broken_seq: 4, reason: 'prev_hash_mismatch' });
  });

  it('detects a deleted middle row', () => {
    const rows = buildChain(6);
    rows.splice(2, 1);
    expect(verifyChain(rows)).toMatchObject({ valid: false, broken_seq: 4, reason: 'missing_rows' });
  });

  it('detects a deleted genesis row', () => {
    const rows = buildChain(4).slice(1);
    expect(verifyChain(rows)).toMatchObject({ valid: false, broken_seq: 2, reason: 'missing_rows' });
  });

  it('detects a forged genesis prev_hash', () => {
    const rows = buildChain(3);
    rows[0] = { ...rows[0]!, prev_hash: 'a'.repeat(64) };
    expect(verifyChain(rows)).toMatchObject({ valid: false, broken_seq: 1, reason: 'bad_genesis' });
  });
});
