import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../src/logger.js';
import type { PolicyInput } from '../../src/policy/policyClient.js';
import { buildPolicyInput, createOpaPolicyClient } from '../../src/policy/policyClient.js';
import { assessRisk } from '../../src/scoring/riskScoring.js';

/**
 * The OPA client's contract: pass well-formed OPA answers through, FAIL CLOSED (block)
 * on anything else. A tiny local HTTP server plays OPA with scripted responses.
 */
let behaviour: (body: string) => { status: number; body: string; delayMs?: number } = () => ({ status: 200, body: '{}' });
let lastBody = '';
const server = createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    lastBody = data;
    const r = behaviour(data);
    setTimeout(() => {
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(r.body);
    }, r.delayMs ?? 0);
  });
});
let url = '';
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const logger = createLogger('silent');
const client = () => createOpaPolicyClient({ opaUrl: url, timeoutMs: 300, logger });
const input: PolicyInput = buildPolicyInput({
  toolName: 'send_email',
  params: { to: 'a@acme.example' },
  risk: assessRisk(null, 'send_email', { to: 'a@acme.example' }, {
    evaluatedAt: new Date('2026-03-04T11:00:00Z'),
    businessHours: { start: 7, end: 21, timeZone: 'UTC' },
    internalEmailDomains: ['acme.example'],
    recentCallCount: 0,
  }),
  agentName: 'unit',
  recentCallCount: 0,
  duplicatePendingCallId: null,
});
const reply = (result: unknown) => () => ({ status: 200, body: JSON.stringify({ result }) });

describe('policy input construction', () => {
  it('sends score + metadata, not scoring math', () => {
    expect(input).toEqual({
      tool: { name: 'send_email', category: 'communication', known: true },
      // No classifier was passed, so the text-bearing call gets the cautious 50 floor.
      risk: { final_score: 50, rule_score: 10, injection_score: null, injection_status: 'unavailable', factors: ['action_type'] },
      context: { agent_name: 'unit', off_hours: false, local_hour: 11, recent_call_count: 0, duplicate_pending_call_id: null },
      params: { to: 'a@acme.example' },
    });
  });
});

describe('OPA client', () => {
  for (const decision of ['allow', 'approve', 'block'] as const) {
    it(`passes through an OPA "${decision}"`, async () => {
      behaviour = reply({ decision, policy_name: `rule_${decision}`, reasons: ['because'] });
      const r = await client().evaluate(input);
      expect(r).toMatchObject({ decision, policy_name: `rule_${decision}`, reasons: ['because'], source: 'opa' });
      expect(JSON.parse(lastBody)).toEqual({ input });
    });
  }

  const failures: [string, typeof behaviour, string][] = [
    ['HTTP 500', () => ({ status: 500, body: '{}' }), 'fail_closed_opa_error'],
    ['non-JSON body', () => ({ status: 200, body: 'not json' }), 'fail_closed_opa_invalid_response'],
    ['missing result (policy not loaded)', () => ({ status: 200, body: '{}' }), 'fail_closed_opa_invalid_response'],
    ['invalid decision value', reply({ decision: 'yes', policy_name: 'x' }), 'fail_closed_opa_invalid_response'],
    ['decision of wrong type', reply({ decision: true, policy_name: 'x' }), 'fail_closed_opa_invalid_response'],
    ['missing policy_name', reply({ decision: 'allow' }), 'fail_closed_opa_invalid_response'],
    ['timeout', () => ({ status: 200, body: JSON.stringify({ result: { decision: 'allow', policy_name: 'x' } }), delayMs: 1000 }), 'fail_closed_opa_timeout'],
  ];
  for (const [name, b, policy] of failures) {
    it(`fails closed (block) on ${name}`, async () => {
      behaviour = b;
      const r = await client().evaluate(input);
      expect(r.decision).toBe('block');
      expect(r.source).toBe('fail_closed');
      expect(r.policy_name).toBe(policy);
    });
  }

  it('fails closed when OPA is unreachable', async () => {
    const dead = createOpaPolicyClient({ opaUrl: 'http://127.0.0.1:9', timeoutMs: 500, logger });
    const r = await dead.evaluate(input);
    expect(r).toMatchObject({ decision: 'block', source: 'fail_closed', policy_name: 'fail_closed_opa_unavailable' });
    expect(await dead.health()).toBe(false);
  });
});
