import type { AppContext } from '../context.js';
import type { DbClient } from '../db/pool.js';
import { appendAudit, withAuditTransaction } from '../audit/auditLog.js';
import { AppError } from '../http/errors.js';
import type { ExecutionResult } from '../tools/mockTools.js';
import { executeMockTool, notExecuted } from '../tools/mockTools.js';

/**
 * Human-in-the-loop approval workflow (FR-006/007/008, Implementation Plan §3.5).
 *
 *  - Resolution is a single conditional UPDATE ... WHERE status = 'pending', so exactly one
 *    resolver wins a race; the loser gets 409 and nothing executes twice.
 *  - The winning transaction also writes the approval_resolved audit row and runs (or
 *    refuses) the mocked tool, so "approved" and "executed" can never diverge.
 *  - Timeouts are enforced by the database clock: an expired item can no longer be
 *    approved, and the sweeper converts it to timeout_denied (default deny). The sweeper is
 *    one atomic statement, so a restart mid-poll neither loses nor double-denies items.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timeout_denied';

export interface ApprovalRow {
  id: string;
  tool_call_id: string;
  status: ApprovalStatus;
  reviewer_id: string | null;
  created_at: Date;
  resolved_at: Date | null;
}

export interface Reviewer {
  id: string;
  username: string;
}

export interface ResolutionResult {
  approval: ApprovalRow & { reviewer_username: string | null };
  execution: ExecutionResult;
}

async function toolCallFor(client: DbClient, toolCallId: string) {
  const r = await client.query<{ tool_name: string; params_json: Record<string, unknown> }>(
    'SELECT tool_name, params_json FROM tool_calls WHERE id = $1',
    [toolCallId],
  );
  return r.rows[0]!;
}

/** Records the outcome of a resolution inside the resolving transaction. */
async function recordResolution(
  client: DbClient,
  approval: ApprovalRow,
  reviewer: Reviewer | null,
  at?: Date,
): Promise<ExecutionResult> {
  const call = await toolCallFor(client, approval.tool_call_id);
  await appendAudit(client, {
    event_type: 'approval_resolved',
    at,
    payload: {
      tool_call_id: approval.tool_call_id,
      approval_id: approval.id,
      status: approval.status,
      reviewer_id: reviewer?.id ?? null,
      reviewer_username: reviewer?.username ?? null,
      resolved_at: approval.resolved_at,
    },
  });
  let execution: ExecutionResult;
  if (approval.status === 'approved') {
    execution = executeMockTool(call.tool_name, call.params_json);
  } else if (approval.status === 'timeout_denied') {
    execution = notExecuted(call.tool_name, 'Approval timed out with no human decision; denied by default.');
  } else {
    execution = notExecuted(call.tool_name, `Rejected by reviewer ${reviewer?.username ?? 'unknown'}.`);
  }
  await appendAudit(client, {
    event_type: execution.executed ? 'tool_executed' : 'tool_not_executed',
    at,
    payload: { tool_call_id: approval.tool_call_id, approval_id: approval.id, ...execution },
  });
  return execution;
}

export async function resolveApproval(
  ctx: AppContext,
  approvalId: string,
  decision: 'approve' | 'reject',
  reviewer: Reviewer,
  at?: Date,
): Promise<ResolutionResult> {
  const timeoutSecs = ctx.config.approvalTimeoutMs / 1000;
  const status: ApprovalStatus = decision === 'approve' ? 'approved' : 'rejected';
  const outcome = await withAuditTransaction(ctx.db, async (client) => {
    const updated = await client.query<ApprovalRow>(
      `UPDATE approvals
          SET status = $2, reviewer_id = $3, resolved_at = COALESCE($5::timestamptz, now())
        WHERE id = $1 AND status = 'pending'
          AND created_at > COALESCE($5::timestamptz, now()) - make_interval(secs => $4)
        RETURNING id, tool_call_id, status, reviewer_id, created_at, resolved_at`,
      [approvalId, status, reviewer.id, timeoutSecs, at ?? null],
    );
    const row = updated.rows[0];
    if (row) {
      const execution = await recordResolution(client, row, reviewer, at);
      return { kind: 'resolved' as const, row, execution };
    }
    // Lost the race, already resolved, expired, or does not exist.
    const existing = await client.query<ApprovalRow & { reviewer_username: string | null }>(
      `SELECT a.id, a.tool_call_id, a.status, a.reviewer_id, a.created_at, a.resolved_at, ad.username AS reviewer_username
         FROM approvals a LEFT JOIN admins ad ON ad.id = a.reviewer_id WHERE a.id = $1`,
      [approvalId],
    );
    const current = existing.rows[0];
    if (!current) return { kind: 'missing' as const };
    if (current.status === 'pending') {
      // Pending but past its deadline: enforce the timeout now, then report the conflict.
      await sweepWithin(client, ctx, [approvalId]);
      return { kind: 'expired' as const };
    }
    return { kind: 'conflict' as const, current };
  });

  if (outcome.kind === 'missing') throw new AppError(404, 'NOT_FOUND', 'Approval not found.');
  if (outcome.kind === 'expired') {
    throw new AppError(409, 'APPROVAL_EXPIRED', 'This approval timed out before a decision was made and was denied by default.', {
      status: 'timeout_denied',
    });
  }
  if (outcome.kind === 'conflict') {
    const c = outcome.current;
    const by = c.status === 'timeout_denied' ? 'timeout' : (c.reviewer_username ?? 'another reviewer');
    throw new AppError(409, 'APPROVAL_ALREADY_RESOLVED', `This approval was already resolved (${c.status}) by ${by}.`, {
      status: c.status,
      resolved_by: by,
      resolved_at: c.resolved_at,
    });
  }
  ctx.logger.info('approval resolved', { approval_id: approvalId, status, reviewer: reviewer.username, executed: outcome.execution.executed });
  return { approval: { ...outcome.row, reviewer_username: reviewer.username }, execution: outcome.execution };
}

async function sweepWithin(client: DbClient, ctx: AppContext, onlyIds?: string[], at?: Date): Promise<ApprovalRow[]> {
  const timeoutSecs = ctx.config.approvalTimeoutMs / 1000;
  const expired = await client.query<ApprovalRow>(
    `UPDATE approvals
        SET status = 'timeout_denied', resolved_at = COALESCE($3::timestamptz, now())
      WHERE status = 'pending'
        AND created_at <= COALESCE($3::timestamptz, now()) - make_interval(secs => $1)
        AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
      RETURNING id, tool_call_id, status, reviewer_id, created_at, resolved_at`,
    [timeoutSecs, onlyIds ?? null, at ?? null],
  );
  for (const row of expired.rows) await recordResolution(client, row, null, at);
  return expired.rows;
}

/** Denies every pending approval older than the timeout (FR-008). Safe to run concurrently. */
export async function sweepExpiredApprovals(ctx: AppContext, at?: Date): Promise<number> {
  const rows = await withAuditTransaction(ctx.db, (client) => sweepWithin(client, ctx, undefined, at));
  for (const r of rows) ctx.logger.warn('approval timed out — denied by default', { approval_id: r.id, tool_call_id: r.tool_call_id });
  return rows.length;
}

/** Starts the background timeout poller. Runs once immediately (resumes after a restart). */
export function startApprovalSweeper(ctx: AppContext): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await sweepExpiredApprovals(ctx);
    } catch (err) {
      ctx.logger.error('approval sweeper failed', { error: (err as Error).message });
    } finally {
      running = false;
    }
  };
  void tick();
  const handle = setInterval(tick, ctx.config.approvalPollIntervalMs);
  handle.unref();
  return () => clearInterval(handle);
}

export interface WaitOutcome {
  status: ApprovalStatus;
  execution: ExecutionResult | null;
  reviewer_username: string | null;
}

/**
 * Blocks (by polling the approvals table) until the approval is resolved or times out —
 * the Implementation Plan's "API blocks and polls the approvals table" behaviour.
 */
export async function waitForResolution(ctx: AppContext, approvalId: string, toolCallId: string): Promise<WaitOutcome> {
  const { approvalPollIntervalMs: interval, approvalTimeoutMs: timeout } = ctx.config;
  const deadline = Date.now() + timeout + 5 * interval + 2000;
  for (;;) {
    const r = await ctx.db.query<{ status: ApprovalStatus; reviewer_username: string | null }>(
      `SELECT a.status, ad.username AS reviewer_username FROM approvals a LEFT JOIN admins ad ON ad.id = a.reviewer_id WHERE a.id = $1`,
      [approvalId],
    );
    const row = r.rows[0];
    if (row && row.status !== 'pending') {
      const exec = await ctx.db.query<{ payload_json: ExecutionResult }>(
        `SELECT payload_json FROM audit_log
          WHERE referenced_call_id = $1 AND event_type IN ('tool_executed', 'tool_not_executed')
          ORDER BY seq DESC LIMIT 1`,
        [toolCallId],
      );
      const p = exec.rows[0]?.payload_json;
      const execution = p ? { executed: p.executed, tool: p.tool, result: p.result, reason: p.reason } : null;
      return { status: row.status, execution, reviewer_username: row.reviewer_username };
    }
    if (Date.now() > deadline) {
      // Sweeper not running (or behind): enforce the deadline ourselves, then re-read.
      await sweepExpiredApprovals(ctx);
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}
