import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyAuditLog } from '../../src/audit/auditLog.js';
import type { Harness } from './harness.js';
import { AGENT_KEY, createHarness, csrf, listen, sleep } from './harness.js';

let h: Harness;
afterEach(async () => h?.close());

const trigger = (h: Harness, name: string) => request(h.app).post(`/api/demo/trigger/${name}`).set('Cookie', h.cookie).set(csrf);

describe('canned demo scenarios run the real pipeline', () => {
  it('normal -> allow + executed; bulk-delete -> pending; injection -> block; unusual-hour payment -> approve', async () => {
    // Real business hours here so the simulated 03:14 clock is genuinely off-hours.
    h = await createHarness({ config: { businessHours: { start: 7, end: 21, timeZone: 'UTC' } } });
    const normal = (await trigger(h, 'normal').expect(200)).body;
    expect(normal.results[0]).toMatchObject({ decision: 'allow', execution: { executed: true }, policy_source: 'opa' });

    const bulk = (await trigger(h, 'bulk-delete').expect(200)).body;
    expect(bulk.results[0]).toMatchObject({ decision: 'pending', policy_decision: 'approve', execution: null });

    const inj = (await trigger(h, 'injection').expect(200)).body;
    expect(inj.results[0]).toMatchObject({ decision: 'block', execution: { executed: false } });
    expect(inj.results[0].risk.injection_score).toBeGreaterThanOrEqual(70);

    const pay = (await trigger(h, 'unusual-hour-payment').expect(200)).body;
    expect(pay.results[0]).toMatchObject({ decision: 'pending', policy_decision: 'approve' });
    expect(pay.results[0].policy_name).toContain('approve_financial_off_hours');
    const detail = await request(h.app).get(`/api/tool-calls/${pay.results[0].call_id}`).set('Cookie', h.cookie).expect(200);
    expect(detail.body.risk.breakdown.evaluated_at_simulated).toBe(true);
    expect(detail.body.risk.breakdown.rules.local_hour).toBe(3);

    // Every scenario call is a real row with a real audit trail, attributed to the scenario runner.
    const rows = (await h.adminDb.query("SELECT a.name FROM tool_calls t JOIN agents a ON a.id = t.agent_id")).rows;
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.name))).toEqual(new Set(['demo-scenario-runner']));
    expect((await h.adminDb.query("SELECT count(*)::int AS n FROM audit_log WHERE event_type = 'demo_scenario_triggered'")).rows[0].n).toBe(4);
    expect((await verifyAuditLog(h.ctx.db)).valid).toBe(true);
  });
});

describe('canned scenarios are clock-independent', () => {
  it('give the documented outcomes even when the real time is outside business hours', async () => {
    // Business window 11:00-12:00 UTC: the real clock is (almost always) off-hours here.
    h = await createHarness({ config: { businessHours: { start: 11, end: 12, timeZone: 'UTC' } } });
    const expected: Record<string, string> = { normal: 'allow', 'bulk-delete': 'pending', injection: 'block', 'unusual-hour-payment': 'pending' };
    for (const [name, decision] of Object.entries(expected)) {
      const r = (await trigger(h, name).expect(200)).body;
      expect(r.results[0].decision, name).toBe(decision);
    }
    const burst = (await trigger(h, 'burst').expect(200)).body;
    expect(burst.summary).toMatchObject({ total: 25, failed: 0, block: 0 });
  });
});

/** Minimal SSE reader over fetch: collects `change` events. */
async function openEvents(url: string, cookie: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${url}/api/events`, { headers: { cookie }, signal: ctrl.signal });
  const events: { table: string; op: string; tool_call_id: string | null }[] = [];
  let ready = false;
  const pump = (async () => {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (frame.includes('event: ready')) ready = true;
          const data = /event: change\ndata: (.*)/.exec(frame)?.[1];
          if (data) events.push(JSON.parse(data));
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return { res, events, isReady: () => ready, close: async () => (ctrl.abort(), await pump) };
}

describe('live updates (backend-brokered realtime) and the 20-30 call burst', () => {
  it('BURST: 25 concurrent agent calls all succeed, stay fast, keep the chain valid, and every insert reaches the live feed', async () => {
    h = await createHarness({ realtime: true });
    for (let i = 0; i < 50 && !h.ctx.changeFeed!.healthy; i++) await sleep(100);
    const { url, server } = await listen(h.app);
    const feed = await openEvents(url, h.cookie);
    expect(feed.res.status).toBe(200);
    for (let i = 0; i < 50 && !feed.isReady(); i++) await sleep(50);

    const N = 25;
    const latencies: number[] = [];
    const responses = await Promise.all(
      Array.from({ length: N }, async (_, i) => {
        const started = performance.now();
        const r = await fetch(`${url}/api/tool-call`, {
          method: 'POST',
          headers: { authorization: `Bearer ${AGENT_KEY}`, 'content-type': 'application/json' },
          body: JSON.stringify({ tool_name: 'run_db_query', params: { query: `SELECT id FROM orders WHERE region = 'EU' LIMIT ${i + 1}` } }),
        });
        latencies.push(performance.now() - started);
        return r;
      }),
    );
    const ok = responses.filter((r) => r.status === 200 || r.status === 202).length;
    await sleep(1000);
    const callInserts = new Set(feed.events.filter((e) => e.table === 'tool_calls').map((e) => e.tool_call_id));
    await feed.close();
    server.close();

    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    const max = Math.max(...latencies);
    console.log(`[perf] burst=${N} ok=${ok} failed=${N - ok} avg=${avg.toFixed(0)}ms max=${max.toFixed(0)}ms live_events=${feed.events.length} tool_call_events=${callInserts.size} dropped=${N - callInserts.size}`);
    expect(ok).toBe(N);
    expect(callInserts.size).toBe(N); // no dropped live updates
    expect(max).toBeLessThan(5000);
    expect((await h.adminDb.query('SELECT count(*)::int AS n FROM policy_decisions')).rows[0].n).toBe(N);
    const v = await verifyAuditLog(h.ctx.db);
    expect(v.valid).toBe(true);
    expect(v.total_rows).toBe(N * 4 + 1); // 4 events per call + the harness's admin_login
  });

  it('live feed reports approval state changes (pending -> resolved)', async () => {
    h = await createHarness({ realtime: true });
    for (let i = 0; i < 50 && !h.ctx.changeFeed!.healthy; i++) await sleep(100);
    const { url, server } = await listen(h.app);
    const feed = await openEvents(url, h.cookie);
    for (let i = 0; i < 50 && !feed.isReady(); i++) await sleep(50);
    const call = await trigger(h, 'bulk-delete').expect(200);
    const approvalId = call.body.results[0].approval.id;
    await request(h.app).post(`/api/approvals/${approvalId}/decide`).set('Cookie', h.cookie).set(csrf).send({ decision: 'approve' }).expect(200);
    await sleep(500);
    await feed.close();
    server.close();
    const approvalOps = feed.events.filter((e) => e.table === 'approvals').map((e) => e.op);
    expect(approvalOps).toEqual(['insert', 'update']);
    expect(feed.events.some((e) => e.table === 'audit_log')).toBe(true);
  });

  it('when the realtime channel is down, /api/events returns 503 so the dashboard falls back to polling', async () => {
    h = await createHarness(); // no change feed
    const r = await request(h.app).get('/api/events').set('Cookie', h.cookie).expect(503);
    expect(r.body.error.code).toBe('REALTIME_UNAVAILABLE');
    // The polling path (plain REST) keeps working.
    await request(h.app).get('/api/tool-calls').set('Cookie', h.cookie).expect(200);
  });

  it('the live channel itself requires an admin session', async () => {
    h = await createHarness({ realtime: true });
    await request(h.app).get('/api/events').expect(401);
  });
});
