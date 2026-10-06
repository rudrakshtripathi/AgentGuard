import type { ToolCategory } from './toolCatalog.js';
import { lookupTool, UNKNOWN_TOOL_BASE_RISK } from './toolCatalog.js';

/**
 * Deterministic, rule-based risk scorer: a weighted checklist (Implementation Plan §3.3,
 * FR-002). Each matching factor adds points; rule_score = min(100, sum of points).
 * Pure function — every input it depends on (time, recent call count) is passed in.
 *
 * Checklist (points):
 *   action type     send_email 10 · run_db_query 10 · process_payment 30 · delete_file 35 · unknown tool 40
 *   target          missing target +15 · sensitive target +20 · external email recipient +10
 *   scope / bulk    >10 email recipients +20 · wildcard/recursive/multi-path delete +25
 *                   destructive SQL (DELETE/DROP/TRUNCATE/UPDATE/ALTER) +30 · mutation without WHERE +20
 *                   irreversible DDL (DROP/TRUNCATE) +20
 *                   sensitive SQL table +15
 *   amount          payment >= 1,000 +10 · payment >= 10,000 +25 (instead of +10) · invalid amount +15
 *   timing          outside business hours +10 (financial/destructive actions: +20)
 *   frequency       >= 15 calls by this agent in the last 60s +10 · >= 30 +20
 */

export interface RuleFactor {
  id: string;
  label: string;
  points: number;
}

export interface RuleContext {
  /** Moment the call is evaluated at (server time; demo scenarios may simulate it). */
  evaluatedAt: Date;
  businessHours: { start: number; end: number; timeZone: string };
  internalEmailDomains: string[];
  /** Calls by the same agent in the 60s before this one. */
  recentCallCount: number;
}

export interface RuleScoreResult {
  rule_score: number;
  category: ToolCategory;
  known_tool: boolean;
  off_hours: boolean;
  local_hour: number;
  factors: RuleFactor[];
}

const SENSITIVE_PATH = /(^\/?$)|(^\/(etc|root|boot|var\/lib|prod|production)(\/|$))|(\.(env|pem|key|kdbx)$)|(secret|credential|password|passwd|backup|finance|payroll|\bhr\b|\.ssh)/i;
const SENSITIVE_TABLE = /\b(users|customers|payments|credentials|passwords|salaries|payroll|api_keys|audit_log)\b/i;
const DESTRUCTIVE_SQL = /^\s*(delete|drop|truncate|update|alter|grant|revoke)\b/i;
const MUTATING_SQL = /^\s*(delete|update)\b/i;
const IRREVERSIBLE_DDL = /^\s*(drop|truncate)\b/i;

export function localHour(at: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(at);
  return Number.parseInt(h, 10) % 24;
}

export function isOffHours(at: Date, hours: RuleContext['businessHours']): boolean {
  const h = localHour(at, hours.timeZone);
  return !(h >= hours.start && h < hours.end);
}

function asStringList(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string').map((s) => s.trim()).filter(Boolean);
  return [];
}

function isPresent(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function scoreRules(toolName: string, params: Record<string, unknown>, ctx: RuleContext): RuleScoreResult {
  const factors: RuleFactor[] = [];
  const add = (id: string, label: string, points: number) => factors.push({ id, label, points });
  const tool = lookupTool(toolName);
  let category: ToolCategory = tool?.category ?? 'unknown';

  if (tool) {
    add('action_type', `Action type "${tool.name}" (${tool.category})`, tool.baseRisk);
    if (!isPresent(params[tool.targetField])) add('target_missing', `Target "${tool.targetField}" is missing: risk is uncertain`, 15);
  } else {
    add('unknown_tool', `Tool "${toolName}" is not in the weighted checklist: conservative default`, UNKNOWN_TOOL_BASE_RISK);
  }

  switch (toolName) {
    case 'send_email': {
      const recipients = [...asStringList(params.to), ...asStringList(params.cc), ...asStringList(params.bcc)];
      const external = recipients.filter((r) => {
        const domain = r.toLowerCase().split('@')[1]?.replace(/[>\s]/g, '');
        return !domain || !ctx.internalEmailDomains.includes(domain);
      });
      if (external.length > 0) add('external_recipient', `${external.length} recipient(s) outside internal domains`, 10);
      if (recipients.length > 10) add('bulk_recipients', `${recipients.length} recipients (bulk send)`, 20);
      break;
    }
    case 'delete_file': {
      const paths = [...asStringList(params.path), ...asStringList(params.paths)];
      if (paths.some((p) => SENSITIVE_PATH.test(p))) add('sensitive_target', 'Target path is sensitive (system, secrets, finance, backups or root)', 20);
      if (params.recursive === true || paths.length > 1 || paths.some((p) => /[*?]/.test(p))) {
        add('bulk_scope', 'Bulk delete (wildcard, recursive or multiple paths)', 25);
      }
      break;
    }
    case 'run_db_query': {
      const query = typeof params.query === 'string' ? params.query : '';
      if (DESTRUCTIVE_SQL.test(query)) {
        category = 'destructive';
        add('destructive_query', 'Query modifies or destroys data', 30);
        if (MUTATING_SQL.test(query) && !/\bwhere\b/i.test(query)) add('unbounded_mutation', 'DELETE/UPDATE without a WHERE clause affects every row', 20);
        if (IRREVERSIBLE_DDL.test(query)) add('irreversible_ddl', 'DROP/TRUNCATE cannot be undone', 20);
      }
      if (SENSITIVE_TABLE.test(query)) add('sensitive_target', 'Query touches a sensitive table', 15);
      break;
    }
    case 'process_payment': {
      const amount = typeof params.amount === 'number' ? params.amount : Number.NaN;
      if (!Number.isFinite(amount) || amount <= 0) add('invalid_amount', 'Payment amount is missing or invalid', 15);
      else if (amount >= 10_000) add('very_large_amount', `Very large payment (${amount})`, 25);
      else if (amount >= 1_000) add('large_amount', `Large payment (${amount})`, 10);
      break;
    }
  }

  const hour = localHour(ctx.evaluatedAt, ctx.businessHours.timeZone);
  const offHours = isOffHours(ctx.evaluatedAt, ctx.businessHours);
  if (offHours) {
    const sensitive = category === 'financial' || category === 'destructive';
    const window = `${ctx.businessHours.start}:00-${ctx.businessHours.end}:00 ${ctx.businessHours.timeZone}`;
    add(
      sensitive ? 'off_hours_sensitive_action' : 'off_hours',
      `Requested at ${String(hour).padStart(2, '0')}:00 local, outside business hours (${window})`,
      sensitive ? 20 : 10,
    );
  }

  if (ctx.recentCallCount >= 30) add('burst_frequency', `${ctx.recentCallCount} calls by this agent in the last 60s`, 20);
  else if (ctx.recentCallCount >= 15) add('high_frequency', `${ctx.recentCallCount} calls by this agent in the last 60s`, 10);

  const total = factors.reduce((sum, f) => sum + f.points, 0);
  return {
    rule_score: Math.min(100, total),
    category,
    known_tool: Boolean(tool),
    off_hours: offHours,
    local_hour: hour,
    factors,
  };
}
