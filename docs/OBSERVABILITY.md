# Observability

AgentGuard exposes Prometheus metrics at `GET /metrics` only when `METRICS_TOKEN` is configured. Scrape it with `Authorization: Bearer <METRICS_TOKEN>`. Requests without the exact token receive 401; agent API keys and admin cookies are not accepted. The token is a secret and must be configured only in the API service and scraper.

Available metrics include:

- `agentguard_tool_calls_total{decision,tool}`; tool names are limited to the known tool allow-list (`other` for all unknown names).
- `agentguard_rule_score` and `agentguard_final_score` histograms, labelled only by the fixed tool allow-list.
- `agentguard_classifier_status_total{status}` for scored, skipped, or unavailable.
- `agentguard_opa_request_duration_seconds` and `agentguard_opa_failures_total`.
- `agentguard_approval_wait_duration_seconds{status}` and `agentguard_pending_approvals`.
- `agentguard_audit_rows_appended_total` and `agentguard_audit_verifications_total{result}`.

No agent-supplied parameter values, email addresses, agent names, rule text, or arbitrary tool names are metric labels. Optional `SENTRY_DSN` enables Sentry reporting for unhandled API errors. Before an event is sent, request data, extras, users, breadcrumbs, and exception messages are removed or replaced with a generic message; request bodies, headers, cookies, and tool parameters are not sent.

## Grafana Cloud free tier

Create a Grafana Cloud account and a Prometheus metrics instance. **You perform account creation and copy the provider-issued endpoint and credentials.** Keep those credentials in your scraper's secret store. The example below uses Grafana Alloy, which runs outside the API and adds the bearer token while scraping:

```hcl
prometheus.scrape "agentguard" {
  targets = [{ __address__ = "<api-host>:<api-port>" }]
  scrape_interval = "60s"
  metrics_path = "/metrics"
  authorization {
    type = "Bearer"
    credentials_file = "/run/secrets/agentguard_metrics_token"
  }
  forward_to = [prometheus.remote_write.grafana.receiver]
}

prometheus.remote_write "grafana" {
  endpoint {
    url = "<grafana-cloud-prometheus-write-url>"
    basic_auth {
      username = "<grafana-cloud-instance-id>"
      password_file = "/run/secrets/grafana_cloud_api_key"
    }
  }
}
```

Store the API's `METRICS_TOKEN` in `/run/secrets/agentguard_metrics_token`; store a Grafana Cloud metrics-write token in `/run/secrets/grafana_cloud_api_key`. Do not commit either file. For Render, Alloy must run somewhere that can reach the Render service over HTTPS; use the API's public HTTPS hostname and port 443 as its target. Protect the metrics endpoint with HTTPS and a long random bearer token.

Grafana Agent reached end of life; use Alloy for a new setup. The same scrape configuration can be adapted to another Prometheus-compatible collector.

## Suggested dashboard layout

1. **Gateway volume and outcomes:** `sum by (decision) (rate(agentguard_tool_calls_total[5m]))` and the same grouped by `tool`.
2. **Risk distribution:** rule and final score histogram quantiles using `_bucket`, `_sum`, and `_count` series, split by the fixed `tool` label.
3. **Dependencies:** OPA request latency quantiles and `rate(agentguard_opa_failures_total[5m])`.
4. **Human review:** `agentguard_pending_approvals` and approval wait time grouped by resolution status.
5. **Audit health:** audit rows appended rate and counts of valid versus invalid audit verification results.
6. **Classifier health:** classifier outcomes by `status`; alert if `unavailable` increases.

Metrics are process-local and reset when the API restarts. They are operational indicators, not a replacement for the database-backed audit log.
