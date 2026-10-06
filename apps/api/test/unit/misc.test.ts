import { describe, expect, it } from 'vitest';
import { assertJsonSafe, decideBody, listCallsQuery, parse, toolCallBody } from '../../src/http/validation.js';
import { AppError } from '../../src/http/errors.js';
import { executeMockTool, notExecuted } from '../../src/tools/mockTools.js';
import { SCENARIOS, atLocalHour } from '../../src/demo/scenarios.js';
import { localHour } from '../../src/scoring/ruleScorer.js';
import { loadConfig } from '../../src/config.js';

describe('request validation', () => {
  it('accepts a well-formed tool call', () => {
    const body = parse(toolCallBody, { tool_name: 'send_email', params: { to: 'x' }, requested_at: '2026-01-01T10:00:00Z' });
    expect(body.tool_name).toBe('send_email');
  });
  it.each([
    [{ params: {} }, /tool_name/],
    [{ tool_name: 'x', params: [] }, /params must be a JSON object/],
    [{ tool_name: 'x', params: 'str' }, /params must be a JSON object/],
    [{ tool_name: 'x y', params: {} }, /tool_name may contain only/],
    [{ tool_name: 'x'.repeat(101), params: {} }, /tool_name/],
    [{ tool_name: 'x', params: {}, requested_at: 'yesterday' }, /requested_at/],
    [{ tool_name: 'x', params: {}, extra: 1 }, /extra|Unrecognized/i],
  ])('rejects %j', (body, msg) => {
    expect(() => parse(toolCallBody, body)).toThrow(msg);
  });
  it('rejects NUL characters, lone surrogates and excessive nesting', () => {
    expect(() => assertJsonSafe({ a: 'x\u0000y' })).toThrow(AppError);
    expect(() => assertJsonSafe({ a: '\ud800' })).toThrow(AppError);
    let deep: unknown = 'x';
    for (let i = 0; i < 30; i++) deep = { d: deep };
    expect(() => assertJsonSafe(deep)).toThrow(/nested too deeply/);
    expect(() => assertJsonSafe({ ok: ['fine', { 'ünïcode 🙂': 'ok' }] })).not.toThrow();
  });
  it('validates approval decisions and list filters', () => {
    expect(() => parse(decideBody, { decision: 'maybe' })).toThrow();
    expect(parse(decideBody, { decision: 'approve' }).decision).toBe('approve');
    expect(() => parse(listCallsQuery, { date_from: '2026-02-01T00:00:00Z', date_to: '2026-01-01T00:00:00Z' })).toThrow(/date_from must be before/);
    expect(() => parse(listCallsQuery, { status: 'weird' })).toThrow();
    expect(parse(listCallsQuery, {})).toMatchObject({ page: 1, page_size: 25 });
  });
});

describe('mock tools', () => {
  it('execute deterministically and say they are sandboxed', () => {
    const r = executeMockTool('process_payment', { recipient: 'A', amount: 10 });
    expect(r).toMatchObject({ executed: true, tool: 'process_payment', result: { tool: 'mock_process_payment', confirmation: 'MOCK-CONFIRMATION' } });
    expect(executeMockTool('process_payment', { recipient: 'A', amount: 10 })).toEqual(r);
    for (const t of ['send_email', 'delete_file', 'run_db_query']) expect(executeMockTool(t, {}).executed).toBe(true);
  });
  it('never execute unknown tools', () => {
    expect(executeMockTool('launch_rockets', {})).toMatchObject({ executed: false });
    expect(executeMockTool('__proto__', {})).toMatchObject({ executed: false });
    expect(notExecuted('x', 'Blocked')).toEqual({ executed: false, tool: 'x', reason: 'Blocked' });
  });
});

describe('demo scenarios', () => {
  it('simulate the unusual-hour clock at 03:xx local time in any timezone', () => {
    for (const tz of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles']) expect(localHour(atLocalHour(3, tz), tz)).toBe(3);
  });
  it('define the required scenarios with a 20-30 call burst', () => {
    expect(Object.keys(SCENARIOS)).toEqual(['normal', 'bulk-delete', 'injection', 'unusual-hour-payment', 'burst']);
    const burst = SCENARIOS.burst!.calls().length;
    expect(burst).toBeGreaterThanOrEqual(20);
    expect(burst).toBeLessThanOrEqual(30);
  });
});

describe('configuration', () => {
  it('requires DATABASE_URL and reports the problem clearly', () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
  });
  it('rejects an invalid timezone at startup', () => {
    expect(() => loadConfig({ DATABASE_URL: 'postgres://x', BUSINESS_TIMEZONE: 'Mars/Base' })).toThrow();
  });
  it('applies documented defaults', () => {
    const c = loadConfig({ DATABASE_URL: 'postgres://x' });
    expect(c).toMatchObject({ opaUrl: 'http://127.0.0.1:8181', apiPort: 4000, approvalTimeoutMs: 120_000, cookieSecure: false });
  });
});
