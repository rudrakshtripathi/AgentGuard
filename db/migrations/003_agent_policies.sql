-- Per-agent policy limits. The API role receives SELECT only; policy changes remain an
-- owner/admin seed or operator action and cannot be made by the agent process.
CREATE TABLE agent_policies (
    agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    allowed_tools text[] NOT NULL DEFAULT ARRAY['send_email', 'delete_file', 'run_db_query', 'process_payment'],
    max_payment_amount numeric(12,2),
    allowed_email_domains text[] NOT NULL DEFAULT '{}',
    max_calls_per_minute integer,
    CHECK (cardinality(allowed_tools) > 0),
    CHECK (max_payment_amount IS NULL OR max_payment_amount >= 0),
    CHECK (max_calls_per_minute IS NULL OR max_calls_per_minute > 0)
);
