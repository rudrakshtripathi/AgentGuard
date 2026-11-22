# Changelog

This project history is grouped by completed implementation phase rather than release version.

## Gateway and audit foundation

Added the API interception pipeline, deterministic risk checklist, prompt-injection classifier, OPA policy decisions, sandboxed mock tools, human approvals, dashboard, and append-only SHA-256 audit chain.

## Scoring and data-loss hardening

Added SQL statement analysis for comments, quoting, multi-statement input, mutating CTEs, and uncertain parses. Added email scanning for credential-like data, private keys, payment-card numbers, and large contact lists. Sensitive-data factors report kinds without copying matched values.

## Container and deployment support

Added pinned multi-stage API and dashboard images, Docker Compose services for Postgres/migrations/API+OPA/dashboard, Render Blueprint configuration, and a Supabase/Render/Vercel deployment runbook.

## CI and security documentation

Added Node 20/24 CI, policy and integration jobs, Playwright workflow, MIT license, vulnerability-reporting policy, and relocated project status documents under `docs/`.

## Observability and audit anchoring

Added token-protected Prometheus metrics, optional scrubbed Sentry reporting, head-only audit endpoints, scheduled external anchor publication, and anchor-aware verification.

## Evaluation and per-agent policies

Added a 272-case synthetic red-team evaluation with CI thresholds and explicit known failures. Added per-agent tool, payment, email-domain, and call-rate limits enforced by OPA and shown on call detail.

## SDK and system documentation

Added the dependency-free TypeScript SDK, examples and tests, plus threat-model, architecture, observability, deployment, and test-results documentation.

## Finalization

Recorded the final local verification results and corrected the README to match the current scoring checklist, selected classifier, endpoints, environment templates, scripts, and known limitations.
