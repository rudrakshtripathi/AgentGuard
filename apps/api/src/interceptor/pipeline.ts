import type { AppContext } from '../context.js';
import { appendAudit, withAuditTransaction } from '../audit/auditLog.js';
import type { RiskAssessment } from '../scoring/riskScoring.js';
import { assessRisk } from '../scoring/riskScoring.js';
import type { PolicyDecision, PolicyResult } from '../policy/policyClient.js';
import { buildPolicyInput } from '../policy/policyClient.js';
import type { ExecutionResult } from '../tools/mockTools.js';
import { executeMockTool, notExecuted } from '../tools/mockTools.js';
import type { ApprovalStatus } from '../approvals/approvals.js';
import { waitForResolution } from '../approvals/approvals.js';
import { errorFields } from '../logger.js';

/**
 * Interceptor (TRD §5): the only path from "agent proposed a tool call" to "mock tool ran".
 *
 *   1. persist tool_calls + audit call_received             (one transaction)
 *   2. Risk Scoring: rules + injection classifier -> final score
 *   3. persist risk_scores + audit score_computed           (one transaction)
 *   4. ask OPA (fail closed on any OPA problem)
 *   5. persist policy_decisions + audit decision_made, then  (one transaction)
 *        allow   -> execute mock tool, audit tool_executed
 *        block   -> do NOT execute,     audit tool_not_executed
 *        approve -> create pending approval, audit approval_requested
 *   6. approve + wait_for_approval -> poll approvals until a human (or the timeout) decides
 *
 * Any unexpected failure after step 1 is converted into a fail-closed block where the
 * database still allows it; nothing ever executes on an error path.
 */

export interface AgentIdentity {
  id: string;
  name: string;
}

export interface ToolCallRequest {
  agent: AgentIdentity;
  toolName: string;
  params: Record<string, unknown>;
  clientRequestedAt: string | null;
  waitForApproval: boolean;
  /** Internal callers only (demo runner, seed): simulate the evaluation clock / backdate rows. */
  internal?: { evaluatedAt?: Date; simulatedTime?: boolean; at?: Date; source?: string };
}

export type GatewayDecision = 'allow' | 'block' | 'pending';

export interface ToolCallOutcome {
  call_id: string;
  /** Gateway outcome for the agent: allow (executed), block (not executed), pending (awaiting human). */
  decision: GatewayDecision;
  policy_decision: PolicyDecision;
  policy_name: string;
  policy_source: PolicyResult['source'];
  reason: string;
  reasons: string[];
  risk: { rule_score: number; injection_score: number | null; final_score: number };
  approval: { id: string; status: ApprovalStatus; expires_at: string; reviewer: string | null } | null;
  execution: ExecutionResult | null;
}

const RECENT_WINDOW_MS = 60_000;

export async function processToolCall(ctx: AppContext, req: ToolCallRequest): Promise<ToolCallOutcome> {
  const at = req.internal?.at;
  const receivedAt = at ?? new Date();
  const { logger } = ctx;

  // 1. Intercept: record the proposed call before anything else happens.
  const callId = await withAuditTransaction(ctx.db, async (client) => {
    const inserted = await client.query<{ id: string }>(
      'INSERT INTO tool_calls (agent_id, tool_name, params_json, requested_at) VALUES ($1, $2, $3, $4) RETURNING id',
      [req.agent.id, req.toolName, req.params, receivedAt],
    );
    const id = inserted.rows[0]!.id;
    await appendAudit(client, {
      event_type: 'call_received',
      at,
      payload: {
        tool_call_id: id,
        agent_id: req.agent.id,
        agent_name: req.agent.name,
        tool_name: req.toolName,
        params: req.params,
        client_requested_at: req.clientRequestedAt,
        source: req.internal?.source ?? 'agent_api',
      },
    });
    return id;
  });
  logger.info('tool call received', { call_id: callId, agent: req.agent.name, tool: req.toolName, source: req.internal?.source ?? 'agent_api' });

  try {
    return await decide(ctx, req, callId, receivedAt);
  } catch (err) {
    logger.error('pipeline failure — failing closed', { call_id: callId, ...errorFields(err) });
    await recordFailClosed(ctx, req, callId, (err as Error).message).catch((e2) =>
      logger.error('could not record fail-closed decision', { call_id: callId, ...errorFields(e2) }),
    );
    throw err;
  }
}

async function decide(ctx: AppContext, req: ToolCallRequest, callId: string, receivedAt: Date): Promise<ToolCallOutcome> {
  const at = req.internal?.at;
  const evaluatedAt = req.internal?.evaluatedAt ?? receivedAt;

  // Context signals for scoring/policy (frequency, duplicate pending approval).
  const recent = await ctx.db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM tool_calls
      WHERE agent_id = $1 AND id <> $2 AND requested_at > $3 AND requested_at <= $4`,
    [req.agent.id, callId, new Date(receivedAt.getTime() - RECENT_WINDOW_MS), receivedAt],
  );
  const recentCallCount = recent.rows[0]!.n;
  const dup = await ctx.db.query<{ id: string }>(
    `SELECT tc.id FROM tool_calls tc JOIN approvals a ON a.tool_call_id = tc.id
      WHERE a.status = 'pending' AND tc.agent_id = $1 AND tc.tool_name = $2 AND tc.params_json = $3::jsonb AND tc.id <> $4
      ORDER BY tc.requested_at LIMIT 1`,
    [req.agent.id, req.toolName, req.params, callId],
  );
  const duplicatePendingCallId = dup.rows[0]?.id ?? null;

  // 2-3. Risk Scoring.
  const risk: RiskAssessment = assessRisk(ctx.classifier, req.toolName, req.params, {
    evaluatedAt,
    simulatedTime: req.internal?.simulatedTime,
    businessHours: ctx.config.businessHours,
    internalEmailDomains: ctx.config.internalEmailDomains,
    recentCallCount,
  });
  await withAuditTransaction(ctx.db, async (client) => {
    await client.query(
      'INSERT INTO risk_scores (tool_call_id, rule_score, injection_score, final_score, computed_at) VALUES ($1, $2, $3, $4, $5)',
      [callId, risk.rule_score, risk.injection_score, risk.final_score, at ?? new Date()],
    );
    await appendAudit(client, {
      event_type: 'score_computed',
      at,
      payload: {
        tool_call_id: callId,
        rule_score: risk.rule_score,
        injection_score: risk.injection_score,
        final_score: risk.final_score,
        breakdown: risk.breakdown,
      },
    });
  });
  ctx.logger.info('risk scored', {
    call_id: callId,
    rule_score: risk.rule_score,
    injection_score: risk.injection_score,
    final_score: risk.final_score,
    injection_status: risk.breakdown.injection.status,
  });

  // 4. Policy (OPA is the single decision authority).
  const policyInput = buildPolicyInput({
    toolName: req.toolName,
    params: req.params,
    risk,
    agentName: req.agent.name,
    recentCallCount,
    duplicatePendingCallId,
  });
  const policy = await ctx.policy.evaluate(policyInput);
  ctx.logger.info('policy decided', { call_id: callId, decision: policy.decision, policy_name: policy.policy_name, source: policy.source });

  // 5. Persist decision + act on it, atomically.
  const acted = await withAuditTransaction(ctx.db, async (client) => {
    await client.query('INSERT INTO policy_decisions (tool_call_id, decision, policy_name, decided_at) VALUES ($1, $2, $3, $4)', [
      callId,
      policy.decision,
      policy.policy_name,
      at ?? new Date(),
    ]);
    await appendAudit(client, {
      event_type: 'decision_made',
      at,
      payload: {
        tool_call_id: callId,
        decision: policy.decision,
        policy_name: policy.policy_name,
        reasons: policy.reasons,
        source: policy.source,
        opa_latency_ms: policy.latency_ms,
        error: policy.error ?? null,
        policy_input: { tool: policyInput.tool, risk: policyInput.risk, context: policyInput.context },
      },
    });
    if (policy.decision === 'approve') {
      const approval = await client.query<{ id: string; created_at: Date }>(
        'INSERT INTO approvals (tool_call_id, status, created_at) VALUES ($1, $2, $3) RETURNING id, created_at',
        [callId, 'pending', at ?? new Date()],
      );
      const a = approval.rows[0]!;
      const expiresAt = new Date(a.created_at.getTime() + ctx.config.approvalTimeoutMs);
      await appendAudit(client, {
        event_type: 'approval_requested',
        at,
        payload: { tool_call_id: callId, approval_id: a.id, expires_at: expiresAt.toISOString() },
      });
      return { approvalId: a.id, expiresAt, execution: null };
    }
    const execution =
      policy.decision === 'allow'
        ? executeMockTool(req.toolName, req.params)
        : notExecuted(req.toolName, `Blocked by AgentGuard policy (${policy.policy_name}).`);
    await appendAudit(client, {
      event_type: execution.executed ? 'tool_executed' : 'tool_not_executed',
      at,
      payload: { tool_call_id: callId, ...execution },
    });
    return { approvalId: null, expiresAt: null, execution };
  });

  const base = {
    call_id: callId,
    policy_decision: policy.decision,
    policy_name: policy.policy_name,
    policy_source: policy.source,
    reasons: policy.reasons,
    reason: policy.reasons.join(' ') || policy.policy_name,
    risk: { rule_score: risk.rule_score, injection_score: risk.injection_score, final_score: risk.final_score },
  };

  if (!acted.approvalId) {
    ctx.logger.info(acted.execution!.executed ? 'mock tool executed' : 'mock tool not executed', { call_id: callId, tool: req.toolName });
    return {
      ...base,
      decision: acted.execution!.executed ? 'allow' : 'block',
      approval: null,
      execution: acted.execution,
    };
  }

  ctx.logger.info('approval created', { call_id: callId, approval_id: acted.approvalId });
  const approval = { id: acted.approvalId, status: 'pending' as ApprovalStatus, expires_at: acted.expiresAt!.toISOString(), reviewer: null };
  if (!req.waitForApproval) return { ...base, decision: 'pending', approval, execution: null };

  // 6. Hold the request until a human decides or the timeout denies it.
  const waited = await waitForResolution(ctx, acted.approvalId, callId);
  const executed = waited.execution?.executed === true;
  const resolutionReason =
    waited.status === 'approved'
      ? `Approved by ${waited.reviewer_username ?? 'a reviewer'}.`
      : waited.status === 'rejected'
        ? `Rejected by ${waited.reviewer_username ?? 'a reviewer'}.`
        : 'Approval timed out; denied by default.';
  return {
    ...base,
    decision: executed ? 'allow' : 'block',
    reason: `${base.reason} ${resolutionReason}`,
    approval: { ...approval, status: waited.status, reviewer: waited.reviewer_username },
    execution: waited.execution,
  };
}

/** Records a fail-closed block for a call whose pipeline crashed (if not already decided). */
async function recordFailClosed(ctx: AppContext, req: ToolCallRequest, callId: string, error: string) {
  await withAuditTransaction(ctx.db, async (client) => {
    const existing = await client.query('SELECT 1 FROM policy_decisions WHERE tool_call_id = $1', [callId]);
    if (existing.rowCount) return;
    await client.query("INSERT INTO policy_decisions (tool_call_id, decision, policy_name) VALUES ($1, 'block', 'fail_closed_pipeline_error')", [
      callId,
    ]);
    await appendAudit(client, {
      event_type: 'decision_made',
      payload: {
        tool_call_id: callId,
        decision: 'block',
        policy_name: 'fail_closed_pipeline_error',
        reasons: ['The pipeline failed before a decision was reached; AgentGuard fails closed.'],
        source: 'fail_closed',
        error,
      },
    });
    await appendAudit(client, {
      event_type: 'tool_not_executed',
      payload: { tool_call_id: callId, ...notExecuted(req.toolName, 'Pipeline error; failed closed.') },
    });
  });
}
