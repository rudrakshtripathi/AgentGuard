/**
 * Demo agent (Implementation Plan §3.1, FR-019): an LLM function-calling loop whose tools
 * are NOT executed locally. Every tool call the model proposes is sent to AgentGuard's
 * POST /api/tool-call; AgentGuard scores it, asks OPA, holds it for human approval if
 * needed, runs the sandboxed mock tool only if permitted, and returns the outcome, which
 * is fed back to the model. The agent has no code path that runs a tool itself.
 */

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const TOOLS: ToolSpec[] = [
  {
    name: 'send_email',
    description: 'Send an email.',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient address(es), comma separated' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['to', 'subject', 'body'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file or directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, recursive: { type: 'boolean' } },
      required: ['path'],
    },
  },
  {
    name: 'run_db_query',
    description: 'Run a SQL query against the company database.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'process_payment',
    description: 'Send a payment to a recipient.',
    parameters: {
      type: 'object',
      properties: {
        recipient: { type: 'string' },
        amount: { type: 'number' },
        currency: { type: 'string' },
        memo: { type: 'string' },
      },
      required: ['recipient', 'amount'],
    },
  },
];

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCallRequest[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface LlmTurn {
  content: string | null;
  toolCalls: ToolCallRequest[];
}

/** The model, abstracted so the loop can be tested without an API key. */
export interface Llm {
  complete(messages: Message[], tools: ToolSpec[]): Promise<LlmTurn>;
}

export interface GuardOutcome {
  call_id: string;
  decision: 'allow' | 'block' | 'pending';
  policy_decision: string;
  reason: string;
  execution: { executed: boolean; result?: unknown; reason?: string } | null;
}

export class AgentGuardClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Submits a proposed call and waits (server-side) for any required human approval. */
  async submit(toolName: string, params: Record<string, unknown>): Promise<GuardOutcome> {
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/$/, '')}/api/tool-call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ tool_name: toolName, params, requested_at: new Date().toISOString(), wait_for_approval: true }),
    });
    const body = (await res.json().catch(() => null)) as (GuardOutcome & { error?: { code: string; message: string } }) | null;
    if (!res.ok || !body || body.error) {
      throw new Error(`AgentGuard rejected the request (HTTP ${res.status}): ${body?.error?.message ?? 'no body'}`);
    }
    return body;
  }
}

export interface RunLog {
  tool: string;
  arguments: Record<string, unknown>;
  outcome?: GuardOutcome;
  error?: string;
}

export async function runAgent(task: string, llm: Llm, guard: AgentGuardClient, opts: { maxSteps?: number; onStep?: (l: RunLog) => void } = {}) {
  const messages: Message[] = [
    {
      role: 'system',
      content:
        'You are an operations assistant with tools for email, files, database queries and payments. ' +
        'Every tool call is reviewed by a security gateway (AgentGuard) which may allow, block, or hold it for human approval. ' +
        'Report the gateway outcome honestly; never claim a blocked action happened.',
    },
    { role: 'user', content: task },
  ];
  const log: RunLog[] = [];
  for (let step = 0; step < (opts.maxSteps ?? 6); step++) {
    const turn = await llm.complete(messages, TOOLS);
    messages.push({ role: 'assistant', content: turn.content, tool_calls: turn.toolCalls.length ? turn.toolCalls : undefined });
    if (turn.toolCalls.length === 0) return { answer: turn.content ?? '', log };
    for (const call of turn.toolCalls) {
      const entry: RunLog = { tool: call.name, arguments: call.arguments };
      try {
        entry.outcome = await guard.submit(call.name, call.arguments);
      } catch (err) {
        entry.error = (err as Error).message;
      }
      log.push(entry);
      opts.onStep?.(entry);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(entry.outcome ?? { error: entry.error }) });
    }
  }
  return { answer: '(stopped: step limit reached)', log };
}
