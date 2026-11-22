export interface AgentGuardClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  fetchImplementation?: typeof fetch;
}

export interface GuardOptions {
  /** Explicit name is recommended if a build tool can minify function names. */
  toolName?: string;
  /** Holds this HTTP request until a human resolves approval; bounded by timeoutMs. */
  waitForApproval?: boolean;
}

interface GatewayExecution {
  executed: boolean;
  tool: string;
  result?: unknown;
  reason?: string;
}

interface GatewayResponse {
  decision: 'allow' | 'block' | 'pending';
  reasons?: string[];
  reason?: string;
  call_id?: string;
  approval?: { id?: string; expires_at?: string; status?: string } | null;
  execution?: GatewayExecution | null;
}

export class AgentGuardError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class AgentGuardBlockedError extends AgentGuardError {
  constructor(readonly reasons: string[], readonly callId?: string) {
    super(reasons.join(' ') || 'AgentGuard blocked this tool call.');
  }
}

export class PendingApprovalError extends AgentGuardError {
  constructor(readonly approvalId: string | undefined, readonly expiresAt: string | undefined, readonly callId?: string) {
    super('This tool call is waiting for human approval.');
  }
}

export class AgentGuardTimeoutError extends AgentGuardError {
  constructor() { super('AgentGuard request timed out; the local tool was not run.'); }
}

export class AgentGuardUnavailableError extends AgentGuardError {
  constructor(options?: ErrorOptions) { super('AgentGuard could not be reached; the local tool was not run.', options); }
}

export class AgentGuardResponseError extends AgentGuardError {
  constructor(message: string, options?: ErrorOptions) { super(message, options); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseResponse(value: unknown): GatewayResponse {
  if (!isRecord(value) || !['allow', 'block', 'pending'].includes(String(value.decision))) {
    throw new AgentGuardResponseError('AgentGuard returned an invalid response; the local tool was not run.');
  }
  if (value.reasons !== undefined && (!Array.isArray(value.reasons) || !value.reasons.every((reason) => typeof reason === 'string'))) {
    throw new AgentGuardResponseError('AgentGuard returned invalid reasons; the local tool was not run.');
  }
  if (value.decision === 'allow' && (!isRecord(value.execution) || value.execution.executed !== true)) {
    throw new AgentGuardResponseError('AgentGuard allowed the call without an execution result; the local tool was not run.');
  }
  if (value.decision === 'pending' && !isRecord(value.approval)) {
    throw new AgentGuardResponseError('AgentGuard returned a pending call without approval details; the local tool was not run.');
  }
  return value as unknown as GatewayResponse;
}

export class AgentGuardClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: AgentGuardClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetcher = options.fetchImplementation ?? fetch;
    if (!this.baseUrl || !options.apiKey) throw new Error('AgentGuard baseUrl and apiKey are required.');
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('timeoutMs must be a positive number.');
  }

  /**
   * Creates an agent-visible handle that routes calls through AgentGuard. `toolFn` supplies
   * the default tool name only; it is intentionally never invoked in the agent process.
   */
  guard<Params extends Record<string, unknown>>(
    toolFn: (params: Params) => unknown,
    guardOptions: GuardOptions = {},
  ): (params: Params) => Promise<GatewayExecution> {
    const toolName = guardOptions.toolName ?? toolFn.name;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(toolName)) throw new Error('A valid toolName is required.');
    return async (params: Params) => {
      let response: Response;
      try {
        response = await this.fetcher(`${this.baseUrl}/api/tool-call`, {
          method: 'POST',
          headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ tool_name: toolName, params, ...(guardOptions.waitForApproval ? { wait_for_approval: true } : {}) }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new AgentGuardTimeoutError();
        throw new AgentGuardUnavailableError({ cause: error });
      }
      if (!response.ok) throw new AgentGuardResponseError(`AgentGuard returned HTTP ${response.status}; the local tool was not run.`);

      let result: GatewayResponse;
      try {
        result = parseResponse(await response.json());
      } catch (error) {
        if (error instanceof AgentGuardResponseError) throw error;
        throw new AgentGuardResponseError('AgentGuard returned a non-JSON response; the local tool was not run.', { cause: error });
      }
      if (result.decision === 'block') throw new AgentGuardBlockedError(result.reasons ?? (result.reason ? [result.reason] : []), result.call_id);
      if (result.decision === 'pending') throw new PendingApprovalError(result.approval?.id, result.approval?.expires_at, result.call_id);
      return result.execution!;
    };
  }
}

export function createAgentGuardClient(options: AgentGuardClientOptions): AgentGuardClient {
  return new AgentGuardClient(options);
}
