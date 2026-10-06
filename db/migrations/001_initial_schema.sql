-- AgentGuard initial schema.
-- Source: AgentGuard_Backend_DB_Schema.md §5. Deviations (documented in
-- AGENTGUARD_IMPLEMENTATION_STATUS.md, "Decisions"):
--   * audit_log.seq: explicit, gapless chain position. The spec orders the chain by
--     created_at, but several audit rows can be written in one transaction (same
--     now()), so timestamp order is not deterministic. seq makes chain order exact
--     and makes deleted rows detectable as gaps.
--   * created_at on audit_log is written by the application (it is part of the
--     hashed record), default kept for safety.
--   * gen_random_uuid() is core since PostgreSQL 13, so pgcrypto is not required.

CREATE TYPE decision_enum AS ENUM ('allow', 'block', 'approve');
CREATE TYPE approval_status_enum AS ENUM ('pending', 'approved', 'rejected', 'timeout_denied');

CREATE TABLE agents (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name           text NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 100),
    api_key_hash   text NOT NULL UNIQUE,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admins (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username       text NOT NULL UNIQUE CHECK (length(username) BETWEEN 1 AND 100),
    password_hash  text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_sessions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    admin_id       uuid NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
    token_hash     text NOT NULL UNIQUE,
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz NOT NULL,
    revoked_at     timestamptz
);

CREATE TABLE tool_calls (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id       uuid NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
    tool_name      text NOT NULL CHECK (length(tool_name) BETWEEN 1 AND 100),
    params_json    jsonb NOT NULL CHECK (jsonb_typeof(params_json) = 'object'),
    requested_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE risk_scores (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tool_call_id     uuid NOT NULL UNIQUE REFERENCES tool_calls(id) ON DELETE CASCADE,
    rule_score       numeric(5,2) NOT NULL CHECK (rule_score >= 0 AND rule_score <= 100),
    injection_score  numeric(5,2) CHECK (injection_score IS NULL OR (injection_score >= 0 AND injection_score <= 100)),
    final_score      numeric(5,2) NOT NULL CHECK (final_score >= 0 AND final_score <= 100),
    computed_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE policy_decisions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tool_call_id   uuid NOT NULL UNIQUE REFERENCES tool_calls(id) ON DELETE CASCADE,
    decision       decision_enum NOT NULL,
    policy_name    text NOT NULL CHECK (length(policy_name) BETWEEN 1 AND 200),
    decided_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approvals (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tool_call_id   uuid NOT NULL UNIQUE REFERENCES tool_calls(id) ON DELETE CASCADE,
    status         approval_status_enum NOT NULL DEFAULT 'pending',
    reviewer_id    uuid REFERENCES admins(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    resolved_at    timestamptz,
    CONSTRAINT resolved_at_required CHECK (status = 'pending' OR resolved_at IS NOT NULL)
);

CREATE TABLE audit_log (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seq                 bigint NOT NULL UNIQUE CHECK (seq >= 1),
    event_type          text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 100),
    payload_json        jsonb NOT NULL CHECK (jsonb_typeof(payload_json) = 'object'),
    prev_hash           text,
    hash                text NOT NULL UNIQUE,
    referenced_call_id  uuid GENERATED ALWAYS AS (
        CASE WHEN (payload_json->>'tool_call_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
             THEN (payload_json->>'tool_call_id')::uuid
        END
    ) STORED,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT genesis_prev_hash CHECK ((seq = 1) = (prev_hash IS NULL))
);

CREATE INDEX idx_tool_calls_agent_id ON tool_calls (agent_id);
CREATE INDEX idx_tool_calls_requested_at ON tool_calls (requested_at);
CREATE INDEX idx_policy_decisions_decision ON policy_decisions (decision);
CREATE INDEX idx_approvals_status_pending ON approvals (status) WHERE status = 'pending';
CREATE INDEX idx_audit_log_created_at ON audit_log (created_at);
CREATE INDEX idx_audit_log_referenced_call_id ON audit_log (referenced_call_id);
CREATE INDEX idx_audit_log_event_type ON audit_log (event_type);
CREATE INDEX idx_admin_sessions_expires_at ON admin_sessions (expires_at);

-- Append-only enforcement, independent of application code (TRD §7, DB spec §5).
-- The application role additionally has no UPDATE/DELETE grant on audit_log
-- (granted by the migration runner, see apps/api/src/db/migrate.ts).
CREATE OR REPLACE FUNCTION reject_audit_log_mutation()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_no_update
BEFORE UPDATE ON audit_log
FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();

CREATE TRIGGER trg_audit_log_no_delete
BEFORE DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION reject_audit_log_mutation();

-- approvals may only ever move out of 'pending', exactly once (DB spec §2 lifecycle).
CREATE OR REPLACE FUNCTION enforce_approval_transition()
RETURNS trigger AS $$
BEGIN
    IF OLD.status <> 'pending' THEN
        RAISE EXCEPTION 'approval % is already resolved (%)', OLD.id, OLD.status;
    END IF;
    IF NEW.tool_call_id <> OLD.tool_call_id OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'approval identity columns are immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_approvals_transition
BEFORE UPDATE ON approvals
FOR EACH ROW EXECUTE FUNCTION enforce_approval_transition();
