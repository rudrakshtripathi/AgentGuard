/**
 * The mocked tools AgentGuard knows about, with the static facts the rule scorer uses.
 * Anything not listed here is an "unknown" tool: still accepted and scored
 * (conservatively), never auto-allowed by policy, and never executed (FR-001, FR-002).
 */
export type ToolCategory = 'communication' | 'read' | 'destructive' | 'financial' | 'unknown';

export interface ToolDefinition {
  name: string;
  category: ToolCategory;
  /** Base points in the weighted checklist (action type). */
  baseRisk: number;
  /** Param holding the action's target; missing target is scored as uncertainty, not zero risk. */
  targetField: string;
  description: string;
}

export const TOOL_CATALOG: Record<string, ToolDefinition> = {
  send_email: {
    name: 'send_email',
    category: 'communication',
    baseRisk: 10,
    targetField: 'to',
    description: 'Send an email (mocked: nothing is sent).',
  },
  run_db_query: {
    name: 'run_db_query',
    category: 'read',
    baseRisk: 10,
    targetField: 'query',
    description: 'Run a SQL query against the business database (mocked: nothing is executed).',
  },
  delete_file: {
    name: 'delete_file',
    category: 'destructive',
    baseRisk: 35,
    targetField: 'path',
    description: 'Delete a file or directory (mocked: nothing is deleted).',
  },
  process_payment: {
    name: 'process_payment',
    category: 'financial',
    baseRisk: 30,
    targetField: 'recipient',
    description: 'Send a payment (mocked: no money moves).',
  },
};

/** Conservative middle score for tools outside the checklist (PRD §5: "not zero"). */
export const UNKNOWN_TOOL_BASE_RISK = 40;

export function lookupTool(name: string): ToolDefinition | undefined {
  return Object.hasOwn(TOOL_CATALOG, name) ? TOOL_CATALOG[name] : undefined;
}
