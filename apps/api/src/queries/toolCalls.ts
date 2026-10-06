import type { Queryable } from '../db/pool.js';
import type { AuditRow } from '../audit/auditLog.js';
import { auditForCall } from '../audit/auditLog.js';

/**
 * Read models for the dashboard. A call's status is DERIVED from its child rows
 * (tool_calls itself is write-once):
 *   no decision yet            -> in_progress
 *   decision allow / block     -> allowed / blocked
 *   decision approve           -> pending | approved | rejected | timeout_denied (approval status)
 */
export const CALL_STATUSES = ['in_progress', 'allowed', 'blocked', 'pending', 'approved', 'rejected', 'timeout_denied'] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

const STATUS_SQL = `CASE
    WHEN pd.decision IS NULL THEN 'in_progress'
    WHEN pd.decision = 'allow' THEN 'allowed'
    WHEN pd.decision = 'block' THEN 'blocked'
    ELSE COALESCE(a.status::text, 'in_progress')
  END`;

const BASE_FROM = `FROM tool_calls tc
  JOIN agents ag ON ag.id = tc.agent_id
  LEFT JOIN risk_scores rs ON rs.tool_call_id = tc.id
  LEFT JOIN policy_decisions pd ON pd.tool_call_id = tc.id
  LEFT JOIN approvals a ON a.tool_call_id = tc.id`;

export interface CallSummary {
  id: string;
  agent_id: string;
  agent_name: string;
  tool_name: string;
  params: Record<string, unknown>;
  requested_at: string;
  status: CallStatus;
  decision: string | null;
  policy_name: string | null;
  rule_score: number | null;
  injection_score: number | null;
  final_score: number | null;
  approval_id: string | null;
}

const SUMMARY_COLUMNS = `tc.id, tc.agent_id, ag.name AS agent_name, tc.tool_name, tc.params_json AS params, tc.requested_at,
  ${STATUS_SQL} AS status, pd.decision::text AS decision, pd.policy_name,
  rs.rule_score, rs.injection_score, rs.final_score, a.id AS approval_id`;

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : d === null || d === undefined ? null : String(d));

function toSummary(row: Record<string, unknown>): CallSummary {
  return { ...(row as unknown as CallSummary), requested_at: iso(row.requested_at)! };
}

export interface ListCallsQuery {
  status?: CallStatus;
  dateFrom?: Date;
  dateTo?: Date;
  page: number;
  pageSize: number;
}

export async function listCalls(db: Queryable, q: ListCallsQuery) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.status) {
    params.push(q.status);
    where.push(`${STATUS_SQL} = $${params.length}`);
  }
  if (q.dateFrom) {
    params.push(q.dateFrom);
    where.push(`tc.requested_at >= $${params.length}`);
  }
  if (q.dateTo) {
    params.push(q.dateTo);
    where.push(`tc.requested_at <= $${params.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = (await db.query<{ n: number }>(`SELECT count(*)::int AS n ${BASE_FROM} ${whereSql}`, params)).rows[0]!.n;
  const rows = await db.query(
    `SELECT ${SUMMARY_COLUMNS} ${BASE_FROM} ${whereSql}
      ORDER BY tc.requested_at DESC, tc.id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, q.pageSize, (q.page - 1) * q.pageSize],
  );
  return {
    items: rows.rows.map(toSummary),
    page: q.page,
    page_size: q.pageSize,
    total,
    total_pages: Math.max(1, Math.ceil(total / q.pageSize)),
  };
}

export interface CallDetail extends CallSummary {
  pipeline_state: 'in_progress' | 'awaiting_approval' | 'complete';
  risk: { rule_score: number; injection_score: number | null; final_score: number; computed_at: string; breakdown: unknown } | null;
  policy: { decision: string; policy_name: string; decided_at: string; reasons: string[]; source: string | null } | null;
  approval: {
    id: string;
    status: string;
    created_at: string;
    expires_at: string;
    resolved_at: string | null;
    reviewer_username: string | null;
  } | null;
  execution: { executed: boolean; tool: string; result?: unknown; reason?: string; recorded_at: string } | null;
  audit_events: AuditRow[];
}

export async function getCallDetail(db: Queryable, id: string, approvalTimeoutMs: number): Promise<CallDetail | null> {
  const r = await db.query(
    `SELECT ${SUMMARY_COLUMNS}, rs.computed_at, pd.decided_at, a.status AS approval_status, a.created_at AS approval_created_at,
            a.resolved_at AS approval_resolved_at, rv.username AS reviewer_username
       ${BASE_FROM} LEFT JOIN admins rv ON rv.id = a.reviewer_id
      WHERE tc.id = $1`,
    [id],
  );
  const row = r.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  const events = await auditForCall(db, id);
  const latest = (type: string) => [...events].reverse().find((e) => e.event_type === type);
  const scored = latest('score_computed');
  const decided = latest('decision_made');
  const exec = [...events].reverse().find((e) => e.event_type === 'tool_executed' || e.event_type === 'tool_not_executed');
  const summary = toSummary(row);

  const approvalCreated = row.approval_created_at as Date | null;
  return {
    ...summary,
    pipeline_state: summary.status === 'in_progress' ? 'in_progress' : summary.status === 'pending' ? 'awaiting_approval' : 'complete',
    risk:
      row.final_score === null || row.final_score === undefined
        ? null
        : {
            rule_score: row.rule_score as number,
            injection_score: row.injection_score as number | null,
            final_score: row.final_score as number,
            computed_at: iso(row.computed_at)!,
            breakdown: scored?.payload_json.breakdown ?? null,
          },
    policy:
      row.decision === null || row.decision === undefined
        ? null
        : {
            decision: row.decision as string,
            policy_name: row.policy_name as string,
            decided_at: iso(row.decided_at)!,
            reasons: (decided?.payload_json.reasons as string[] | undefined) ?? [],
            source: (decided?.payload_json.source as string | undefined) ?? null,
          },
    approval: summary.approval_id
      ? {
          id: summary.approval_id,
          status: row.approval_status as string,
          created_at: iso(approvalCreated)!,
          expires_at: new Date(approvalCreated!.getTime() + approvalTimeoutMs).toISOString(),
          resolved_at: iso(row.approval_resolved_at),
          reviewer_username: (row.reviewer_username as string | null) ?? null,
        }
      : null,
    execution: exec
      ? {
          executed: exec.payload_json.executed as boolean,
          tool: exec.payload_json.tool as string,
          result: exec.payload_json.result,
          reason: exec.payload_json.reason as string | undefined,
          recorded_at: exec.created_at,
        }
      : null,
    audit_events: events,
  };
}

export async function listPendingApprovals(db: Queryable, approvalTimeoutMs: number) {
  const r = await db.query(
    `SELECT a.id AS approval_id, a.created_at AS approval_created_at, ${SUMMARY_COLUMNS},
            (SELECT al.payload_json->'reasons' FROM audit_log al
              WHERE al.referenced_call_id = tc.id AND al.event_type = 'decision_made' ORDER BY al.seq DESC LIMIT 1) AS reasons
       ${BASE_FROM}
      WHERE a.status = 'pending'
      ORDER BY a.created_at ASC`,
  );
  return r.rows.map((row: Record<string, unknown>) => {
    const created = row.approval_created_at as Date;
    return {
      ...toSummary(row),
      approval_id: row.approval_id as string,
      reasons: (row.reasons as string[] | null) ?? [],
      approval_created_at: created.toISOString(),
      expires_at: new Date(created.getTime() + approvalTimeoutMs).toISOString(),
    };
  });
}

export type StatsRange = '24h' | '7d';

export async function getStats(db: Queryable, range: StatsRange, timeZone: string) {
  const counts = await db.query<{ status: CallStatus; n: number }>(
    `SELECT ${STATUS_SQL} AS status, count(*)::int AS n ${BASE_FROM} GROUP BY 1`,
  );
  const by = Object.fromEntries(CALL_STATUSES.map((s) => [s, 0])) as Record<CallStatus, number>;
  for (const row of counts.rows) by[row.status] = row.n;
  const total = Object.values(by).reduce((a, b) => a + b, 0);

  const unit = range === '24h' ? 'hour' : 'day';
  const steps = range === '24h' ? 23 : 6;
  const series = await db.query<{ bucket: Date; total: number; allowed: number; blocked: number; pending: number }>(
    `WITH buckets AS (
       SELECT generate_series(
                date_trunc($1, now(), $2) - make_interval(hours => CASE WHEN $1 = 'hour' THEN $3 ELSE 0 END,
                                                          days  => CASE WHEN $1 = 'day'  THEN $3 ELSE 0 END),
                date_trunc($1, now(), $2),
                CASE WHEN $1 = 'hour' THEN interval '1 hour' ELSE interval '1 day' END) AS bucket
     ), calls AS (
       SELECT date_trunc($1, tc.requested_at, $2) AS bucket, ${STATUS_SQL} AS status ${BASE_FROM}
        WHERE tc.requested_at >= (SELECT min(bucket) FROM buckets)
     )
     SELECT b.bucket,
            count(c.status)::int AS total,
            count(*) FILTER (WHERE c.status IN ('allowed', 'approved'))::int AS allowed,
            count(*) FILTER (WHERE c.status IN ('blocked', 'rejected', 'timeout_denied'))::int AS blocked,
            count(*) FILTER (WHERE c.status IN ('pending', 'in_progress'))::int AS pending
       FROM buckets b LEFT JOIN calls c ON c.bucket = b.bucket
      GROUP BY b.bucket ORDER BY b.bucket`,
    [unit, timeZone, steps],
  );
  return {
    total,
    // "allowed" = actions that were permitted to execute; "blocked" = actions that never executed.
    allowed: by.allowed + by.approved,
    blocked: by.blocked + by.rejected + by.timeout_denied,
    pending: by.pending,
    in_progress: by.in_progress,
    by_status: by,
    range,
    time_zone: timeZone,
    series: series.rows.map((s) => ({ ...s, bucket: s.bucket.toISOString() })),
  };
}
