import { describe, expect, it } from 'vitest';
import type { GuardOutcome, Llm, LlmTurn, Message } from './agent.js';
import { AgentGuardClient, TOOLS, runAgent } from './agent.js';

/** Scripted model: proposes the given tool calls, then answers. */
function scriptedLlm(turns: LlmTurn[]): Llm & { seen: Message[][] } {
  const seen: Message[][] = [];
  let i = 0;
  return {
    seen,
    async complete(messages) {
      seen.push(structuredClone(messages));
      return turns[i++] ?? { content: 'done', toolCalls: [] };
    },
  };
}

function fakeGateway(outcomes: Record<string, GuardOutcome>) {
  const requests: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push({ url, headers: init.headers as Record<string, string>, body });
    return new Response(JSON.stringify(outcomes[body.tool_name]), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

const allow: GuardOutcome = { call_id: '1', decision: 'allow', policy_decision: 'allow', reason: 'low risk', execution: { executed: true, result: { ok: 1 } } };
const block: GuardOutcome = { call_id: '2', decision: 'block', policy_decision: 'block', reason: 'injection', execution: { executed: false, reason: 'Blocked' } };

describe('demo agent', () => {
  it('exposes exactly the four mocked tools', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(['send_email', 'delete_file', 'run_db_query', 'process_payment']);
  });

  it('routes every proposed tool call through AgentGuard and feeds the outcome back to the model', async () => {
    const gw = fakeGateway({ send_email: allow, delete_file: block });
    const llm = scriptedLlm([
      {
        content: null,
        toolCalls: [
          { id: 'a', name: 'send_email', arguments: { to: 'm@acme.example', subject: 's', body: 'b' } },
          { id: 'b', name: 'delete_file', arguments: { path: '/srv/*', recursive: true } },
        ],
      },
      { content: 'Email sent; the delete was blocked.', toolCalls: [] },
    ]);
    const guard = new AgentGuardClient('http://guard.test/', 'ag_key', gw.fetchImpl);
    const { answer, log } = await runAgent('do things', llm, guard);
    expect(answer).toBe('Email sent; the delete was blocked.');
    expect(gw.requests.map((r) => r.url)).toEqual(['http://guard.test/api/tool-call', 'http://guard.test/api/tool-call']);
    expect(gw.requests[0]!.headers.authorization).toBe('Bearer ag_key');
    expect(gw.requests[0]!.body).toMatchObject({ tool_name: 'send_email', wait_for_approval: true });
    expect(log.map((l) => l.outcome?.decision)).toEqual(['allow', 'block']);
    const toolMessages = llm.seen[1]!.filter((m) => m.role === 'tool');
    expect(toolMessages).toHaveLength(2);
    expect(JSON.parse((toolMessages[1] as { content: string }).content).execution.executed).toBe(false);
  });

  it('reports gateway errors to the model instead of executing anything', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: 'INVALID_API_KEY', message: 'Invalid agent API key.' } }), { status: 401 })) as unknown as typeof fetch;
    const llm = scriptedLlm([{ content: null, toolCalls: [{ id: 'x', name: 'process_payment', arguments: { recipient: 'A', amount: 5 } }] }]);
    const { log } = await runAgent('pay', llm, new AgentGuardClient('http://g', 'bad', fetchImpl));
    expect(log[0]!.error).toMatch(/HTTP 401.*Invalid agent API key/);
  });

  it('stops at the step limit', async () => {
    const gw = fakeGateway({ run_db_query: allow });
    const loop: LlmTurn = { content: null, toolCalls: [{ id: 'q', name: 'run_db_query', arguments: { query: 'SELECT 1' } }] };
    const r = await runAgent('loop', scriptedLlm(Array(10).fill(loop)), new AgentGuardClient('http://g', 'k', gw.fetchImpl), { maxSteps: 3 });
    expect(r.answer).toMatch(/step limit/);
    expect(gw.requests).toHaveLength(3);
  });
});
