import type { RiskAssessment } from '../scoring/riskScoring.js';
import type { Logger } from '../logger.js';

/**
 * OPA Policy Client (TRD §5). Express never decides allow/block/approve itself: it asks
 * OPA and consumes the answer. If OPA is unreachable, times out, or answers with anything
 * other than a well-formed decision, AgentGuard FAILS CLOSED: the call is blocked and
 * labelled with a fail_closed_* policy name (TRD §12, §18 — resolves PRD Open Question #5).
 */

export type PolicyDecision = 'allow' | 'block' | 'approve';

export interface PolicyInput {
  tool: { name: string; category: string; known: boolean };
  risk: {
    final_score: number;
    rule_score: number;
    injection_score: number | null;
    injection_status: string;
    factors: string[];
  };
  context: {
    agent_name: string;
    off_hours: boolean;
    local_hour: number;
    recent_call_count: number;
    duplicate_pending_call_id: string | null;
  };
  params: Record<string, unknown>;
}

export interface PolicyResult {
  decision: PolicyDecision;
  policy_name: string;
  reasons: string[];
  /** "opa" when OPA decided; "fail_closed" when AgentGuard denied because OPA could not. */
  source: 'opa' | 'fail_closed';
  latency_ms: number;
  error?: string;
}

export function buildPolicyInput(args: {
  toolName: string;
  params: Record<string, unknown>;
  risk: RiskAssessment;
  agentName: string;
  recentCallCount: number;
  duplicatePendingCallId: string | null;
}): PolicyInput {
  const { rules, injection } = args.risk.breakdown;
  return {
    tool: { name: args.toolName, category: rules.category, known: rules.known_tool },
    risk: {
      final_score: args.risk.final_score,
      rule_score: args.risk.rule_score,
      injection_score: args.risk.injection_score,
      injection_status: injection.status,
      factors: rules.factors.map((f) => f.id),
    },
    context: {
      agent_name: args.agentName,
      off_hours: rules.off_hours,
      local_hour: rules.local_hour,
      recent_call_count: args.recentCallCount,
      duplicate_pending_call_id: args.duplicatePendingCallId,
    },
    params: args.params,
  };
}

const DECISIONS = new Set<PolicyDecision>(['allow', 'block', 'approve']);

export interface PolicyClient {
  evaluate(input: PolicyInput): Promise<PolicyResult>;
  health(): Promise<boolean>;
}

export function createOpaPolicyClient(opts: { opaUrl: string; timeoutMs: number; logger: Logger }): PolicyClient {
  const decisionUrl = `${opts.opaUrl}/v1/data/agentguard/policy/result`;

  const failClosed = (policy_name: string, error: string, started: number): PolicyResult => {
    opts.logger.error('OPA unavailable or invalid response — failing closed (block)', { policy_name, error });
    return {
      decision: 'block',
      policy_name,
      reasons: [`Policy engine could not decide (${error}); AgentGuard fails closed and blocks the call.`],
      source: 'fail_closed',
      latency_ms: Date.now() - started,
      error,
    };
  };

  return {
    async evaluate(input) {
      const started = Date.now();
      let response: Response;
      try {
        response = await fetch(decisionUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input }),
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
      } catch (err) {
        const e = err as Error;
        const reason = e.name === 'TimeoutError' ? `timed out after ${opts.timeoutMs}ms` : `unreachable: ${e.message}`;
        return failClosed(e.name === 'TimeoutError' ? 'fail_closed_opa_timeout' : 'fail_closed_opa_unavailable', reason, started);
      }
      if (!response.ok) return failClosed('fail_closed_opa_error', `HTTP ${response.status}`, started);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return failClosed('fail_closed_opa_invalid_response', 'response is not JSON', started);
      }
      const result = (body as { result?: unknown })?.result as Partial<Record<'decision' | 'policy_name' | 'reasons', unknown>> | undefined;
      if (!result || typeof result !== 'object') {
        return failClosed('fail_closed_opa_invalid_response', 'no result (is the agentguard policy loaded?)', started);
      }
      if (typeof result.decision !== 'string' || !DECISIONS.has(result.decision as PolicyDecision)) {
        return failClosed('fail_closed_opa_invalid_response', `invalid decision ${JSON.stringify(result.decision)}`, started);
      }
      const policy_name = typeof result.policy_name === 'string' && result.policy_name.length > 0 ? result.policy_name.slice(0, 200) : null;
      if (!policy_name) return failClosed('fail_closed_opa_invalid_response', 'missing policy_name', started);
      const reasons = Array.isArray(result.reasons) ? result.reasons.filter((r): r is string => typeof r === 'string') : [];
      const decided: PolicyResult = {
        decision: result.decision as PolicyDecision,
        policy_name,
        reasons,
        source: 'opa',
        latency_ms: Date.now() - started,
      };
      opts.logger.debug('OPA decision', { decision: decided.decision, policy_name, latency_ms: decided.latency_ms });
      return decided;
    },
    async health() {
      try {
        const res = await fetch(`${opts.opaUrl}/health?bundles`, { signal: AbortSignal.timeout(opts.timeoutMs) });
        if (!res.ok) return false;
        // Also confirm our policy package is actually loaded.
        const probe = await fetch(decisionUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"input":{}}',
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
        const body = (await probe.json()) as { result?: { decision?: string } };
        return probe.ok && body.result?.decision === 'block';
      } catch {
        return false;
      }
    },
  };
}
