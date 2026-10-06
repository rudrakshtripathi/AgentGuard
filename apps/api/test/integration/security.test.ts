import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { Harness } from './harness.js';
import { ADMIN, AGENT_KEY, agentAuth, createHarness, submit } from './harness.js';

let h: Harness;
afterEach(async () => h?.close());

const rejections = async (h: Harness) =>
  (await h.adminDb.query("SELECT payload_json->>'reason' AS reason FROM audit_log WHERE event_type = 'request_rejected' ORDER BY seq")).rows.map(
    (r) => r.reason as string,
  );

describe('security: trust boundaries', () => {
  it('rejects missing and invalid agent keys (401) and audits each attempt', async () => {
    h = await createHarness();
    const body = { tool_name: 'send_email', params: {} };
    expect((await request(h.app).post('/api/tool-call').send(body).expect(401)).body.error.code).toBe('AGENT_AUTH_REQUIRED');
    expect((await request(h.app).post('/api/tool-call').set('authorization', 'Bearer ag_wrongwrongwrongwrong').send(body).expect(401)).body.error.code).toBe('INVALID_API_KEY');
    await request(h.app).post('/api/tool-call').set('authorization', 'Basic YWRtaW46eA==').send(body).expect(401);
    expect(await rejections(h)).toEqual(['missing_api_key', 'invalid_api_key', 'missing_api_key']);
  });

  it('an admin session cannot act as an agent (admin -> agent-only endpoint is 401)', async () => {
    h = await createHarness();
    const r = await request(h.app).post('/api/tool-call').set('Cookie', h.cookie).set('x-agentguard-csrf', '1').send({ tool_name: 'send_email', params: {} }).expect(401);
    expect(r.body.error.message).toMatch(/admin sessions cannot submit tool calls/);
    // nor can the raw session token be used as a bearer key
    const token = h.cookie.split('=')[1]!;
    await request(h.app).post('/api/tool-call').set('authorization', `Bearer ${token}`).send({ tool_name: 'send_email', params: {} }).expect(401);
    expect((await h.adminDb.query('SELECT count(*)::int AS n FROM tool_calls')).rows[0].n).toBe(0);
  });

  it('an agent key cannot reach admin endpoints even with a valid admin cookie attached (403)', async () => {
    h = await createHarness();
    await request(h.app).get('/api/stats').set(agentAuth).set('Cookie', h.cookie).expect(403);
  });

  it('the agent cannot approve its own escalated call', async () => {
    h = await createHarness();
    const call = await submit(h, { tool_name: 'delete_file', params: { path: '/x/*', recursive: true } }).expect(202);
    await request(h.app).post(`/api/approvals/${call.body.approval.id}/decide`).set(agentAuth).set('x-agentguard-csrf', '1').send({ decision: 'approve' }).expect(403);
    expect((await h.adminDb.query('SELECT status FROM approvals')).rows[0].status).toBe('pending');
  });
});

describe('security: hostile input', () => {
  it('SQL injection payloads are stored as inert data; schema and other rows are untouched', async () => {
    h = await createHarness();
    const payload = "'; DROP TABLE audit_log; --";
    const res = await submit(h, { tool_name: "send_email'; DELETE FROM agents; --", params: { to: payload, body: "1' OR '1'='1" } });
    expect(res.status).toBe(400); // tool_name charset is validated
    const ok = await submit(h, { tool_name: 'run_db_query', params: { query: payload, note: "1' OR '1'='1" } });
    expect([200, 202]).toContain(ok.status);
    const stored = (await h.adminDb.query('SELECT params_json FROM tool_calls WHERE id = $1', [ok.body.call_id])).rows[0].params_json;
    expect(stored).toEqual({ query: payload, note: "1' OR '1'='1" });
    expect((await h.adminDb.query("SELECT to_regclass('public.audit_log') IS NOT NULL AS ok")).rows[0].ok).toBe(true);
    expect((await h.adminDb.query('SELECT count(*)::int AS n FROM agents')).rows[0].n).toBe(3);
  });

  it('XSS payloads are returned verbatim as JSON data (rendered as text by the dashboard)', async () => {
    h = await createHarness();
    const xss = '<img src=x onerror=alert(1)><script>alert("x")</script>';
    const res = await submit(h, { tool_name: 'send_email', params: { to: 'a@acme.example', subject: xss, body: xss } });
    const detail = await request(h.app).get(`/api/tool-calls/${res.body.call_id}`).set('Cookie', h.cookie).expect(200);
    expect(detail.headers['content-type']).toMatch(/application\/json/);
    expect(detail.headers['x-content-type-options']).toBe('nosniff');
    expect(detail.body.params.subject).toBe(xss);
  });

  it('malformed JSON -> 400 MALFORMED_JSON, still audited', async () => {
    h = await createHarness();
    const r = await request(h.app).post('/api/tool-call').set(agentAuth).set('content-type', 'application/json').send('{"tool_name": "x", ').expect(400);
    expect(r.body.error.code).toBe('MALFORMED_JSON');
    expect(await rejections(h)).toEqual(['malformed_json']);
  });

  it('oversized payloads -> 413, still audited; nothing persisted', async () => {
    h = await createHarness();
    const r = await submit(h, { tool_name: 'send_email', params: { body: 'x'.repeat(70_000) } }).expect(413);
    expect(r.body.error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(await rejections(h)).toEqual(['payload_too_large']);
    expect((await h.adminDb.query('SELECT count(*)::int AS n FROM tool_calls')).rows[0].n).toBe(0);
  });

  it('schema-invalid bodies -> 400 with a clear message, audited as validation_failed', async () => {
    h = await createHarness();
    for (const body of [{}, { tool_name: 'x', params: [] }, { tool_name: 'x', params: { a: 'nul\u0000byte' } }, { tool_name: 'x', params: {}, sneaky: true }]) {
      const r = await submit(h, body).expect(400);
      expect(r.body.error.code).toBe('INVALID_REQUEST');
    }
    expect(await rejections(h)).toEqual(Array(4).fill('validation_failed'));
  });

  it('errors never leak stack traces or internals', async () => {
    h = await createHarness();
    const r = await request(h.app).post('/api/tool-call').set(agentAuth).set('content-type', 'application/json').send('{bad');
    expect(JSON.stringify(r.body)).not.toMatch(/at \w+ \(|node_modules|\.ts:/);
  });

  it('secrets never appear in the audit log or in the database in plaintext', async () => {
    h = await createHarness();
    await submit(h, { tool_name: 'send_email', params: { to: 'a@acme.example', body: 'hello' } });
    await request(h.app).post('/api/auth/login').send({ ...ADMIN, password: 'wrong-password-123' });
    const dump = JSON.stringify(
      (await h.adminDb.query("SELECT (SELECT json_agg(a) FROM audit_log a) AS audit, (SELECT json_agg(s) FROM admin_sessions s) AS s, (SELECT json_agg(g) FROM agents g) AS g, (SELECT json_agg(ad) FROM admins ad) AS ad")).rows[0],
    );
    expect(dump).not.toContain(AGENT_KEY);
    expect(dump).not.toContain(ADMIN.password);
    expect(dump).not.toContain('wrong-password-123');
    expect(dump).not.toContain(h.cookie.split('=')[1]);
    expect(dump).toMatch(/\$2[aby]\$12\$/); // bcrypt hash present
  });

  it('per-agent rate limit returns 429 and audits it', async () => {
    h = await createHarness({ config: { agentRateLimitPerMinute: 3 } });
    for (let i = 0; i < 3; i++) await submit(h, { tool_name: 'run_db_query', params: { query: 'SELECT 1' } });
    expect((await submit(h, { tool_name: 'run_db_query', params: { query: 'SELECT 1' } }).expect(429)).body.error.code).toBe('RATE_LIMITED');
    expect(await rejections(h)).toEqual(['rate_limited']);
  });
});
