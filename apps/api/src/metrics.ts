import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();
collectDefaultMetrics({ register: metricsRegistry });

const tools = new Set(['send_email', 'delete_file', 'run_db_query', 'process_payment']);
export function metricToolName(value: string): string {
  return tools.has(value) ? value : 'other';
}

export const toolCalls = new Counter({
  name: 'agentguard_tool_calls_total', help: 'Tool calls by final policy decision and fixed tool name.',
  labelNames: ['decision', 'tool'] as const, registers: [metricsRegistry],
});
export const ruleScore = new Histogram({
  name: 'agentguard_rule_score', help: 'Rule risk score distribution.', labelNames: ['tool'] as const,
  buckets: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100], registers: [metricsRegistry],
});
export const finalScore = new Histogram({
  name: 'agentguard_final_score', help: 'Final risk score distribution.', labelNames: ['tool'] as const,
  buckets: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100], registers: [metricsRegistry],
});
export const classifierStatus = new Counter({
  name: 'agentguard_classifier_status_total', help: 'Risk classifier outcomes.', labelNames: ['status'] as const,
  registers: [metricsRegistry],
});
export const opaLatency = new Histogram({
  name: 'agentguard_opa_request_duration_seconds', help: 'OPA request latency.',
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5], registers: [metricsRegistry],
});
export const opaFailures = new Counter({
  name: 'agentguard_opa_failures_total', help: 'OPA requests that failed closed.', registers: [metricsRegistry],
});
export const approvalWait = new Histogram({
  name: 'agentguard_approval_wait_duration_seconds', help: 'Time spent waiting for approval resolution.',
  labelNames: ['status'] as const, buckets: [1, 5, 15, 30, 60, 120, 300, 600], registers: [metricsRegistry],
});
export const pendingApprovals = new Gauge({
  name: 'agentguard_pending_approvals', help: 'Current number of pending approvals.', registers: [metricsRegistry],
});
export const auditRows = new Counter({
  name: 'agentguard_audit_rows_appended_total', help: 'Audit rows appended to the hash chain.', registers: [metricsRegistry],
});
export const auditVerifications = new Counter({
  name: 'agentguard_audit_verifications_total', help: 'Audit chain verification outcomes.',
  labelNames: ['result'] as const, registers: [metricsRegistry],
});
