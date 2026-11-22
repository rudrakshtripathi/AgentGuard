import { describe, expect, it, vi } from 'vitest';
import {
  AgentGuardBlockedError,
  AgentGuardClient,
  AgentGuardResponseError,
  AgentGuardTimeoutError,
  AgentGuardUnavailableError,
  PendingApprovalError,
} from '../src/index.js';

const params = { recipient: 'demo', amount: 5 };
const allowed = { decision: 'allow', execution: { executed: true, tool: 'process_payment', result: { tool: 'mock_payment' } } };
function clientWith(response: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(response), { status }));
  return { client: new AgentGuardClient({ baseUrl: 'http://localhost:4000/', apiKey: 'ag_test_key_0123456789', fetchImplementation: fetcher }), fetcher };
}
function localTool() { throw new Error('Agent-side implementation must never run.'); }

describe('AgentGuard SDK', () => {
  it('routes an allow to the gateway and returns its execution result', async () => {
    const { client, fetcher } = clientWith(allowed);
    const handle = client.guard(localTool, { toolName: 'process_payment' });
    const result = await handle(params);
    expect(result).toEqual(allowed.execution);
    expect(fetcher).toHaveBeenCalledOnce();
    const init = fetcher.mock.calls[0]![1]!;
    expect(init.headers).toMatchObject({ authorization: 'Bearer ag_test_key_0123456789' });
    expect(JSON.parse(String(init.body))).toEqual({ tool_name: 'process_payment', params });
  });

  it('throws a typed block error without invoking the local tool', async () => {
    const { client } = clientWith({ decision: 'block', reasons: ['Policy denied.'], call_id: 'call-1', execution: { executed: false } });
    const spy = vi.fn(localTool);
    const handle = client.guard(spy, { toolName: 'process_payment' });
    await expect(handle(params)).rejects.toMatchObject<Partial<AgentGuardBlockedError>>({ reasons: ['Policy denied.'], callId: 'call-1' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws a typed pending error unless the caller opts into waiting', async () => {
    const pending = { decision: 'pending', call_id: 'call-2', approval: { id: 'approval-2', expires_at: 'later' } };
    const { client, fetcher } = clientWith(pending, 202);
    const spy = vi.fn(localTool);
    await expect(client.guard(spy, { toolName: 'send_email' })(params)).rejects.toBeInstanceOf(PendingApprovalError);
    expect(spy).not.toHaveBeenCalled();
    const waiting = clientWith(allowed);
    await expect(waiting.client.guard(spy, { toolName: 'send_email', waitForApproval: true })(params)).resolves.toEqual(allowed.execution);
    expect(JSON.parse(String(waiting.fetcher.mock.calls[0]![1]!.body)).wait_for_approval).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('fails closed on timeout, network failure, and invalid responses', async () => {
    const timed = new AgentGuardClient({ baseUrl: 'http://localhost', apiKey: 'key', fetchImplementation: vi.fn(async () => { throw new DOMException('timeout', 'TimeoutError'); }) });
    const offline = new AgentGuardClient({ baseUrl: 'http://localhost', apiKey: 'key', fetchImplementation: vi.fn(async () => { throw new Error('offline'); }) });
    const invalid = clientWith({ decision: 'allow', execution: { executed: false } }).client;
    const errorStatus = clientWith(allowed, 500).client;
    const spy = vi.fn(localTool);
    const handle = (client: AgentGuardClient) => client.guard(spy, { toolName: 'send_email' })(params);
    await expect(handle(timed)).rejects.toBeInstanceOf(AgentGuardTimeoutError);
    await expect(handle(offline)).rejects.toBeInstanceOf(AgentGuardUnavailableError);
    await expect(handle(invalid)).rejects.toBeInstanceOf(AgentGuardResponseError);
    await expect(handle(errorStatus)).rejects.toBeInstanceOf(AgentGuardResponseError);
    expect(spy).not.toHaveBeenCalled();
  });
});
