import pg from 'pg';

/**
 * Drops every AgentGuard-owned object so migrations can be re-applied from scratch.
 * Development/test only — requires the owner (DATABASE_ADMIN_URL) connection.
 * Only AgentGuard's own objects are dropped, never the whole schema (safe on Supabase).
 */
export async function dropAll(adminUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(`
      DROP TABLE IF EXISTS audit_log, approvals, policy_decisions, risk_scores, tool_calls,
                           admin_sessions, admins, agents, schema_migrations CASCADE;
      DROP TYPE IF EXISTS decision_enum, approval_status_enum CASCADE;
      DROP FUNCTION IF EXISTS reject_audit_log_mutation() CASCADE;
      DROP FUNCTION IF EXISTS enforce_approval_transition() CASCADE;
      DROP FUNCTION IF EXISTS agentguard_notify_change() CASCADE;
    `);
  } finally {
    await client.end();
  }
}

/** Empties all data tables (keeps schema). TRUNCATE does not fire the row-level DELETE trigger. */
export async function truncateAll(adminUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(
      'TRUNCATE audit_log, approvals, policy_decisions, risk_scores, tool_calls, admin_sessions, admins, agents CASCADE',
    );
  } finally {
    await client.end();
  }
}
