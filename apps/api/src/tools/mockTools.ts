/**
 * Sandboxed mock tools (Implementation Plan §3.1, FR-019). NOTHING here touches the real
 * world: no email is sent, no file is deleted, no SQL runs, no money moves. Results are
 * deterministic so tests and demos are repeatable.
 *
 * These functions are only ever invoked by AgentGuard's execution step after an `allow`
 * decision or a human approval (see interceptor/pipeline.ts and approvals/approvals.ts).
 * The demo agent never executes tools itself; it only proposes calls to AgentGuard.
 */

export interface ExecutionResult {
  executed: boolean;
  tool: string;
  result?: Record<string, unknown>;
  reason?: string;
}

type MockTool = (params: Record<string, unknown>) => Record<string, unknown>;

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);
const list = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : typeof v === 'string' ? [v] : []);

export const MOCK_TOOLS: Record<string, MockTool> = {
  send_email: (p) => ({
    tool: 'mock_send_email',
    message: 'Mock email sent (sandbox: nothing was actually delivered).',
    to: list(p.to),
    subject: str(p.subject, '(no subject)'),
  }),
  delete_file: (p) => ({
    tool: 'mock_delete_file',
    message: 'Mock delete performed (sandbox: no file was actually deleted).',
    paths: [...list(p.path), ...list(p.paths)],
    recursive: p.recursive === true,
  }),
  run_db_query: (p) => ({
    tool: 'mock_run_db_query',
    message: 'Mock query executed (sandbox: no database was touched).',
    query: str(p.query),
    rows: [],
    row_count: 0,
  }),
  process_payment: (p) => ({
    tool: 'mock_process_payment',
    message: 'Mock payment processed (sandbox: no money moved).',
    recipient: str(p.recipient),
    amount: typeof p.amount === 'number' ? p.amount : null,
    currency: str(p.currency, 'USD'),
    confirmation: 'MOCK-CONFIRMATION',
  }),
};

export function executeMockTool(toolName: string, params: Record<string, unknown>): ExecutionResult {
  const tool = Object.hasOwn(MOCK_TOOLS, toolName) ? MOCK_TOOLS[toolName] : undefined;
  if (!tool) return { executed: false, tool: toolName, reason: `No sandboxed implementation exists for "${toolName}"; nothing was executed.` };
  return { executed: true, tool: toolName, result: tool(params) };
}

export function notExecuted(toolName: string, reason: string): ExecutionResult {
  return { executed: false, tool: toolName, reason };
}
