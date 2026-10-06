-- Live dashboard updates (FR-016).
-- Every insert/update on the tables the dashboard displays emits a NOTIFY on the
-- 'agentguard_changes' channel. The Express backend LISTENs on one connection and
-- relays events to authenticated dashboard sessions over Server-Sent Events.
--
-- Why not Supabase Realtime from the browser: the DB spec (§11) documents that our
-- custom admin login provides no auth.uid() for RLS, so a browser-held anon key would
-- expose the tables. This implements the spec's option 2 ("backend-brokered realtime
-- channel"); polling every 2.5s is the fallback when the channel is unavailable.
-- Payloads carry identifiers only, never row contents.

CREATE OR REPLACE FUNCTION agentguard_notify_change()
RETURNS trigger AS $$
DECLARE
    call_id uuid;
BEGIN
    IF TG_TABLE_NAME = 'tool_calls' THEN
        call_id := NEW.id;
    ELSIF TG_TABLE_NAME = 'audit_log' THEN
        call_id := NEW.referenced_call_id;
    ELSE
        call_id := NEW.tool_call_id;
    END IF;
    PERFORM pg_notify(
        'agentguard_changes',
        json_build_object('table', TG_TABLE_NAME, 'op', lower(TG_OP), 'id', NEW.id, 'tool_call_id', call_id)::text
    );
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_notify_tool_calls AFTER INSERT ON tool_calls
FOR EACH ROW EXECUTE FUNCTION agentguard_notify_change();
CREATE TRIGGER trg_notify_policy_decisions AFTER INSERT ON policy_decisions
FOR EACH ROW EXECUTE FUNCTION agentguard_notify_change();
CREATE TRIGGER trg_notify_approvals AFTER INSERT OR UPDATE ON approvals
FOR EACH ROW EXECUTE FUNCTION agentguard_notify_change();
CREATE TRIGGER trg_notify_audit_log AFTER INSERT ON audit_log
FOR EACH ROW EXECUTE FUNCTION agentguard_notify_change();
