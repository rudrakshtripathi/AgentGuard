// Response shapes of the AgentGuard API (see apps/api/src/queries/toolCalls.ts and routes.ts).

export type CallStatus = 'in_progress' | 'allowed' | 'blocked' | 'pending' | 'approved' | 'rejected' | 'timeout_denied';

export interface CallSummary {
  id: string;
  agent_id: string;
  agent_name: string;
  tool_name: string;
  params: Record<string, unknown>;
  requested_at: string;
  status: CallStatus;
  decision: 'allow' | 'block' | 'approve' | null;
  policy_name: string | null;
  rule_score: number | null;
  injection_score: number | null;
  final_score: number | null;
  approval_id: string | null;
}

export interface Paged<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
  total_pages: number;
}

export interface RuleFactor {
  id: string;
  label: string;
  points: number;
}

export interface AuditRow {
  id: string;
  seq: number;
  event_type: string;
  payload_json: Record<string, unknown>;
  prev_hash: string | null;
  hash: string;
  referenced_call_id: string | null;
  created_at: string;
}

export interface CallDetail extends CallSummary {
  pipeline_state: 'in_progress' | 'awaiting_approval' | 'complete';
  risk: {
    rule_score: number;
    injection_score: number | null;
    final_score: number;
    computed_at: string;
    breakdown: {
      combination: string;
      evaluated_at: string;
      evaluated_at_simulated: boolean;
      rules: { rule_score: number; category: string; known_tool: boolean; off_hours: boolean; local_hour: number; factors: RuleFactor[] };
      injection: { injection_score: number | null; status: 'scored' | 'skipped' | 'unavailable'; detail: string };
    } | null;
  } | null;
  policy: { decision: string; policy_name: string; decided_at: string; reasons: string[]; source: string | null } | null;
  approval: { id: string; status: string; created_at: string; expires_at: string; resolved_at: string | null; reviewer_username: string | null } | null;
  execution: { executed: boolean; tool: string; result?: unknown; reason?: string; recorded_at: string } | null;
  audit_events: AuditRow[];
}

export interface PendingApproval extends CallSummary {
  approval_id: string;
  reasons: string[];
  approval_created_at: string;
  expires_at: string;
}

export interface Stats {
  total: number;
  allowed: number;
  blocked: number;
  pending: number;
  in_progress: number;
  by_status: Record<CallStatus, number>;
  range: '24h' | '7d';
  time_zone: string;
  series: { bucket: string; total: number; allowed: number; blocked: number; pending: number }[];
}

export interface VerifyResult {
  valid: boolean;
  status: 'empty' | 'valid' | 'tampered';
  total_rows: number;
  verified_rows: number;
  broken_row_id: string | null;
  broken_seq: number | null;
  reason: string | null;
  message: string;
  checked_at: string;
}

export interface ScenarioInfo {
  name: string;
  title: string;
  description: string;
  expected: string;
}

export interface ToolCallOutcome {
  call_id: string;
  decision: 'allow' | 'block' | 'pending';
  policy_decision: 'allow' | 'block' | 'approve';
  policy_name: string;
  reason: string;
  risk: { rule_score: number; injection_score: number | null; final_score: number };
  approval: { id: string; status: string } | null;
  execution: { executed: boolean } | null;
}

export interface ScenarioResult {
  scenario: string;
  title: string;
  results: ToolCallOutcome[];
  summary: { total: number; allow: number; block: number; pending: number; failed: number; avg_latency_ms: number; max_latency_ms: number };
}
