# AgentGuard

[![CI](https://github.com/rudrakshtripathi/AgentGuard/actions/workflows/ci.yml/badge.svg)](https://github.com/rudrakshtripathi/AgentGuard/actions/workflows/ci.yml)

A policy-enforcement gateway that sits between an AI agent's decision to call a tool and the tool actually running. Every proposed call is **intercepted**, **scored** for risk (rule checklist + a small prompt-injection classifier), **decided by OPA** (allow / block / human approval), **executed only if permitted** (sandboxed mock tools), and **written to a hash-chained, tamper-evident audit log** — all visible live on a dashboard.

This is a time-boxed academic / demo build (single process, single database, no queues). Its limits are stated plainly in [Known limitations](#known-limitations).

## Quick start in 5 minutes

### Local

Requires Node.js 20.11+ and npm. Setup creates `.env`, prints the generated admin password once, downloads the checksum-verified OPA binary, and installs Playwright Chromium.

```bash
npm install
npm run setup
npm run db:start
```

Keep Postgres running. In separate terminals, run:

```bash
npm run db:migrate
npm run opa:start
```

After OPA is ready, seed and start the API, then start the dashboard in another terminal:

```bash
npm run db:seed
npm run dev:api
```

```bash
npm run dev:dashboard
```

Open <http://localhost:3000/login>. The API and health endpoint are at <http://127.0.0.1:4000> and <http://127.0.0.1:4000/health>; OPA listens on `127.0.0.1:8181`. The generated local admin password is printed by setup and stored in the ignored root `.env` as `ADMIN_PASSWORD`.

### Docker

Requires Docker Engine with Compose. Copy the example, replace its placeholders, then start and seed:

```bash
cp .env.docker.example .env
docker compose up --build -d
docker compose run --rm migrate apps/api/docker-seed.mjs
```

Open <http://localhost:3000/login>; the API health check is at <http://localhost:4000/health>. The Docker admin password is the `ADMIN_PASSWORD` value you entered in the root `.env`.

See [Run with Docker](#run-with-docker) for shutdown and volume details.

```
Demo agent ──POST /api/tool-call──► Interceptor ─► Risk scoring ─► OPA (Rego) ─┬─ allow   ─► mock tool runs
                                         │              │              │        ├─ block   ─► never runs
                                         ▼              ▼              ▼        └─ approve ─► pending ─► human on /approvals
                                   ┌───────────── PostgreSQL (Supabase-compatible) ──────────────┐           │ approve → runs
                                   │ tool_calls · risk_scores · policy_decisions · approvals      │           │ reject / timeout → never runs
                                   │ audit_log (append-only, SHA-256 hash chain)                   │◄──────────┘
                                   └──────────── NOTIFY ─► API ─► SSE ─► Next.js dashboard ───────┘
```

## Contents

- [Stack](#stack) · [Repository layout](#repository-layout)
- [Setup](#setup) (prerequisites → running)
- [Tests and verification](#tests-and-verification)
- [Demo procedure](#demo-procedure)
- [How it works](#how-it-works) · [API](#api) · [Environment variables](#environment-variables)
- [Troubleshooting](#troubleshooting) · [Known limitations](#known-limitations)
- [Deployment runbook](docs/DEPLOYMENT.md)
- [Threat model](docs/THREAT_MODEL.md) · [Architecture](docs/ARCHITECTURE.md)
- [SDK](docs/SDK.md) · [Observability](docs/OBSERVABILITY.md)
- [Changelog](docs/CHANGELOG.md) · [Test and results](docs/test%20and%20results.md)
- Status documents: [`AGENTGUARD_IMPLEMENTATION_STATUS.md`](docs/AGENTGUARD_IMPLEMENTATION_STATUS.md), [`AGENTGUARD_ACCEPTANCE_TEST.md`](docs/AGENTGUARD_ACCEPTANCE_TEST.md), [`AGENTGUARD_FINAL_VERIFICATION.md`](docs/AGENTGUARD_FINAL_VERIFICATION.md)

## Stack

| Layer      | Technology                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------------- |
| Dashboard  | Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4                                  |
| API        | Node.js · Express 5 · TypeScript (strict) — one process                                           |
| Database   | PostgreSQL 17 (local via `embedded-postgres`, or Supabase / any Postgres ≥ 13)                    |
| Policy     | Open Policy Agent 1.21 · Rego v1                                                                  |
| Classifier | scikit-learn TF-IDF + LogisticRegression (Python, training only) → JSON → inference in TypeScript |
| Demo agent | OpenAI function calling (`openai` SDK) — the single LLM provider                                  |
| Tests      | Vitest · Supertest · Playwright · `opa test`                                                      |

## Repository layout

```
apps/api/            Express gateway
  src/interceptor/   pipeline: intercept → score → OPA → act → audit
  src/scoring/       rule scorer, SQL tokenizer, sensitive-data scanner, classifier inference
  src/policy/        OPA client (fail-closed)
  src/approvals/     approval resolution, timeout sweeper, blocking waiter
  src/audit/         hash chain, append-only writer, verifier
  src/auth/          agent API keys, admin sessions, CSRF
  src/tools/         sandboxed mock tools
  src/demo/          canned scenarios
  src/realtime/      Postgres LISTEN → Server-Sent Events
  src/devtools/      seed + controlled tamper tool (never imported by the server)
  models/            trained classifier (committed) + sklearn parity samples
  test/unit, test/integration
apps/dashboard/      Next.js dashboard (7 screens, components named per the UI spec)
apps/demo-agent/     OpenAI function-calling agent that routes every tool call through AgentGuard
packages/agentguard-sdk/ dependency-free TypeScript SDK and examples
policies/            agentguard.rego + agentguard_test.rego
db/migrations/       forward-only SQL migrations
evals/               labelled tool-call cases and metric thresholds
ml/                  dataset generator, hand-written challenge set, training script
docs/                 deployment, security, architecture, operations, and test records
e2e/                 Playwright demo-flow suite
scripts/             setup, db-start, opa install/start/test, health, verify, burst, e2e
```

## Setup

### 1. Prerequisites

| Tool       | Version                                                                                                    | Needed for                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Node.js    | **≥ 20.11** (developed on 24.19)                                                                           | everything                                                          |
| npm        | ≥ 10 (developed on 11.17)                                                                                  | package manager (npm workspaces)                                    |
| Python     | 3.10+ (developed on 3.12)                                                                                  | **only** to retrain the classifier — the trained model is committed |
| PostgreSQL | none to install — `npm run db:start` runs a real Postgres 17 locally. Or use Supabase / your own Postgres. |                                                                     |
| OPA        | none to install — `npm run setup` downloads the official binary (SHA-256 verified) into `tools/bin/`       |                                                                     |

Windows note: run as a normal (non-administrator) user — PostgreSQL refuses to start as an administrator.

### 2. Install and configure

```bash
npm install
npm run setup        # creates .env with generated secrets, downloads OPA, installs Playwright Chromium
```

`npm run setup` prints the generated dashboard password once; it is stored in `.env` (`ADMIN_PASSWORD`). It never overwrites an existing `.env`. To configure by hand instead: `cp .env.example .env` and replace every `CHANGE_ME` value.

> npm ≥ 11 blocks dependency install scripts unless approved. The two this project needs (`esbuild`, used by `tsx`, and the `@embedded-postgres/<platform>` binary) are pre-approved in `package.json` → `allowScripts`. If `npm install` warns about them anyway, run `npm approve-scripts esbuild @embedded-postgres/<your-platform>`.

### 3. Database

Local (recommended for development) — leave this running in its own terminal:

```bash
npm run db:start     # Postgres 17 on 127.0.0.1:54329, data in .data/postgres; creates agentguard, agentguard_test, agentguard_e2e
```

Then, in another terminal:

```bash
npm run db:migrate   # applies db/migrations and provisions the least-privilege app role from DATABASE_URL
```

**Supabase instead:** set `DATABASE_ADMIN_URL` to the `postgres` connection string and `DATABASE_URL` to the same host with a new role name/password of your choice (e.g. `agentguard_app`), both using the **session-mode** pooler (port 5432) — live updates need `LISTEN`, which the transaction pooler (6543) does not support. `npm run db:migrate` creates that role. Integration tests and E2E need two extra empty databases (`agentguard_test`, `agentguard_e2e`) or the `TEST_DATABASE_*` / `E2E_DATABASE_*` overrides.

### 4. OPA (own terminal)

```bash
npm run opa:start    # opa run --server on 127.0.0.1:8181 loading ./policies (watching for edits)
npm run opa:test     # opa check --strict + opa test policies -v
```

### 5. Classifier (optional — model is committed)

```bash
npm run ml:setup       # creates ml/.venv and installs the pinned scikit-learn, numpy, and pandas versions
npm run ml:compare     # grouped nested-CV comparison, final challenge report, and selected-model export
npm run ml:train       # regenerates grouped training data, then repeats comparison and export
```

The committed model is the selected word-only TF-IDF + LogisticRegression classifier (`word_logistic`, C=10, class-balanced). The training data has 903 rows (473 benign, 430 injection) grouped into 239 source groups. Model comparison used 5 outer `StratifiedGroupKFold` folds with nested 3-fold tuning; 100 additional handwritten rows are included in training, and a separate 30-example challenge set was held out for final reporting. Results below are mean ± standard deviation:

| Model                              | Recall @ 5% FPR |         Brier | Challenge accuracy |
| ---------------------------------- | --------------: | ------------: | -----------------: |
| Word + char LogisticRegression     |   0.995 ± 0.006 | 0.014 ± 0.004 |              0.967 |
| Word + char calibrated LinearSVC   |   0.995 ± 0.006 | 0.015 ± 0.006 |              0.967 |
| Word calibrated LinearSVC          |   0.995 ± 0.010 | 0.021 ± 0.009 |                  — |
| Word LogisticRegression (selected) |   0.988 ± 0.020 | 0.026 ± 0.025 |              0.967 |
| Complement Naive Bayes             |   0.981 ± 0.024 | 0.048 ± 0.012 |                  — |

Word-only LogisticRegression remains selected because the word+character LogisticRegression recall improvement is within one standard deviation of the word-only baseline. On grouped CV, selected-model recall at 5% FPR is 0.988 ± 0.020 and accuracy is 0.972 ± 0.014 (`ml/model/metrics.json`). On the separate challenge set it scored 0.967 accuracy, 0.938 precision, and 1.000 recall (TN 14, FP 1, FN 0, TP 15). The dataset is small and partly template-generated; these measurements are not a production accuracy guarantee. See [`ml/model/comparison.md`](ml/model/comparison.md) for other models and policy operating points.

### 6. Seed demo data (OPA must be running)

```bash
npm run db:seed               # admin + agents; 54 historical calls through the REAL pipeline (only if the DB is empty)
npm run db:reset -- --yes     # drop everything, re-migrate, re-seed (fresh demo dataset)
```

### 7. Run (each in its own terminal)

```bash
npm run dev:api          # http://127.0.0.1:4000   (production: npm run build && npm run start:api)
npm run dev:dashboard    # http://localhost:3000   (production: npm run build && npm run start:dashboard)
npm run health           # env, model, database, OPA, API, dashboard — all should PASS
```

Log in at http://localhost:3000/login with `ADMIN_USERNAME` / `ADMIN_PASSWORD` from `.env`.

## Run with Docker

Copy `.env.docker.example` to `.env`, replace every `CHANGE_ME` value (use URL-safe characters in passwords), then start the stack:

```bash
cp .env.docker.example .env
docker compose up --build
```

The Postgres healthcheck gates the one-off migration service; the API starts after migrations succeed, followed by the dashboard. In another terminal, seed the demo data:

```bash
docker compose run --rm migrate apps/api/docker-seed.mjs
```

Open <http://localhost:3000/login> and sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD` from `.env`. Stop the stack with `docker compose down`; add `-v` only when you also want to remove the database volume.

## Tests and verification

| Command                              | What it runs                                                                                                                                                                                                                                                                                               | Needs                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `npm run typecheck` / `npm run lint` | TypeScript checks across workspaces / ESLint.                                                                                                                                                                                                                                                              | Installed dependencies.                                    |
| `npm run test:unit`                  | API, demo-agent and SDK unit tests.                                                                                                                                                                                                                                                                        | Installed dependencies.                                    |
| `npm run opa:test`                   | Rego policy tests.                                                                                                                                                                                                                                                                                         | OPA binary (`npm run opa:install`).                        |
| `npm run test:integration`           | Pipeline, API, security, audit, realtime and burst integration tests on `agentguard_test`.                                                                                                                                                                                                                 | Postgres and OPA running.                                  |
| `npm run test:e2e`                   | Resets `agentguard_e2e`, builds the dashboard, and runs Playwright/Chromium on API :4100 and dashboard :3100.                                                                                                                                                                                              | Postgres, OPA and Chromium.                                |
| `npm run eval`                       | Runs the labeled cases through the rule scorer and OPA; writes `.data/eval-report.json`.                                                                                                                                                                                                                   | OPA running.                                               |
| `npm run audit:verify`               | Standalone chain verifier; optional `-- --anchors <path-or-URL>` also checks published anchors.                                                                                                                                                                                                            | Postgres; anchors are optional.                            |
| `npm run demo:burst`                 | Sends 25 concurrent agent calls and prints outcomes/latency.                                                                                                                                                                                                                                               | Seeded database, OPA and API running.                      |
| **`npm run verify`**                 | **Runs typecheck, lint, unit, OPA, migration, integration, production build, E2E and health checks. It starts embedded Postgres/OPA if needed, prints a summary and fails on any failed stage. It does not run `npm run eval` or the manual demo.** Use `npm run verify -- --skip-e2e` to omit Playwright. | Node; the first `npm run setup` installs OPA and Chromium. |

## Evaluation

Run `npm run eval` with OPA available at `OPA_URL` (start it with `npm run opa:start`). The runner sends every original case in [`evals/cases.json`](evals/cases.json) through the production rule scorer and live Rego policy, without a database, and writes a JSON report to ignored `.data/eval-report.json`. CI runs the same suite and uploads that report.

Current baseline: **272 cases**, **97.1% exact decision accuracy**, **100% attack detection** (attacks routed to approve or block), and **10.0% benign decision false-positive rate**. These are results on this hand-written synthetic suite, not an estimate of production accuracy. Known false positives are marked directly in the data with `known_failure` and a reason: classifier escalation of quoted SQL vocabulary and a benign password-policy email. The suite currently has no attack cases that were auto-allowed; it does not cover every real-world attack or measure impact severity.

## Per-agent policy

Each agent can have an allow-list of tools, a maximum payment amount, allowed email domains, and a call-rate cap. The `demo-agent` and `reporting-bot` have different payment and domain limits; the policy values used for a decision are visible read-only on the call detail page and recorded in its `decision_made` audit event. The demo procedure remains unchanged; the seeded `demo-scenario-runner` uses the neutral policy defaults so canned outcomes stay stable.

## TypeScript SDK

Use [`@agentguard/sdk`](docs/SDK.md) to give an agent guarded tool handles that route every call to AgentGuard. The original tool implementation must not be callable by the agent directly; keep real tools and their credentials behind the gateway. The examples use only the repository's sandboxed mock tools.

## Demo procedure

### Two-minute walkthrough

1. Log in to the dashboard and trigger **Normal action**; show the allow decision and mock execution.
2. Trigger **Bulk delete**; show the approval queue, approve it, then open the call detail to inspect the policy and audit events.
3. Compare a `demo-agent` call with a `reporting-bot` call in call detail to show their different payment caps and allowed email domains; the integration test also sends the same $60,000 payment through both policies and asserts different decisions.
4. Trigger **Prompt injection**; show the block and confirm the mock tool did not execute.
5. Open **Audit Log** and run verification; show a valid chain. The `npm run audit:verify -- --anchors <path-or-URL>` command also checks published head anchors.

See the deployment/run instructions above for starting services and seeding demo data.

Before the demo: `npm run db:reset -- --yes` (fresh, seeded, verifiable history), start Postgres, OPA, API and dashboard, run `npm run health`.

1. **Login** → Overview shows real counts and the calls-over-time chart from seeded history.
2. **/demo → Normal action → Trigger** → _Allowed_, "Mock tool executed". Click **View call**: rule checklist, classifier probability, the OPA rule that fired and why.
3. **/demo → Bulk delete** → _Pending approval_. Open **/approvals**: the card shows target, parameters, risk, OPA reasons and a countdown to default-deny. Click **Approve** → toast "Approved — the action was executed (sandboxed)"; the call detail now shows the reviewer and execution.
4. **/demo → Prompt injection** → _Blocked_, tool not executed; detail shows P(injection) and `block_high_risk_score`.
5. **/demo → Unusual-hour payment** → _Pending_ via `approve_financial_off_hours` (evaluated at a simulated 03:14, labelled as such). Reject or approve.
6. **/audit-log → Verify integrity** → PASS.
7. Terminal: `npm run demo:tamper` (flips the decision inside a stored `decision_made` row, as a DB attacker would) → **Verify integrity** → **FAIL at row #N**; "Show row #N" highlights it.
8. `npm run demo:tamper -- --restore` → Verify → PASS.
9. **/demo → Burst of calls** (or `npm run demo:burst`) with **/activity** open: 25 rows stream in live.
10. Optional live, unscripted run (needs `OPENAI_API_KEY`): `npm run agent -- "Delete every file under /srv/reports and email me when done"` — the agent's calls appear live and approval-gated ones wait for you on /approvals.

Canned scenarios never call the LLM. Every scenario pins its evaluation clock (11:14 local; 03:14 for the payment) so outcomes are identical whatever time the demo runs — shown on the call detail as "simulated time".

## How it works

**Interceptor (`apps/api/src/interceptor/pipeline.ts`).** One transaction records `tool_calls` + `call_received`; scoring writes `risk_scores` + `score_computed` (with the full breakdown); OPA is asked; one transaction writes `policy_decisions` + `decision_made` and then either executes the mock tool (`tool_executed`), refuses (`tool_not_executed`) or creates a pending approval (`approval_requested`). Any unexpected error after interception records a fail-closed block. Rejected requests (bad key, malformed JSON, too large, invalid) are audited as `request_rejected`.

**Risk scoring (`src/scoring`).** Deterministic weighted checklist — action type (email 10, query 10, payment 30, delete 35, unknown tool 40), target (missing +15, sensitive +20, external recipient +10), scope (bulk recipients +20, wildcard/recursive delete +25, any destructive SQL statement +30, unbounded mutation +20, DROP/TRUNCATE +20, sensitive table +15, SQL analysis uncertain +40, sensitive email content +25, sensitive email content to an external recipient +15), amount (≥1k +10, ≥10k +25, invalid +15), timing (outside business hours +10, +20 for financial/destructive), frequency (≥15 calls/60 s +10, ≥30 +20); capped at 100. SQL analysis handles comments, quoted text, multiple statements and data-modifying CTEs conservatively. Email scanning detects credential patterns, private keys, Luhn-valid card numbers, high-entropy tokens, and long email/phone lists; breakdowns contain only data kinds, never matched values. Combination: `final = max(rule, injection)`; classification skipped (no text) → `final = rule` with `injection_score` NULL; classifier unavailable → `final = max(rule, 50)`.

**Classifier (`ml/`).** The selected `word_logistic` model uses word-only TF-IDF (1–2 grams) and class-balanced LogisticRegression (C=10), exported to JSON for TypeScript inference. Its dataset has 903 rows (473 benign, 430 injection) in 239 source groups. Grouped nested CV reports 0.988 ± 0.020 recall at 5% FPR and 0.972 ± 0.014 accuracy; the separate 30-example challenge set reports 0.967 accuracy, 0.938 precision, and 1.000 recall. These small synthetic/template-heavy measurements are not production estimates. The inference implementation matches sklearn to 1e-9 in the parity test.

**Policy (`policies/agentguard.rego`).** Bands from the spec: final < 30 allow · 30–70 approve · ≥ 70 block; plus block on injection score ≥ 80 or a duplicate of a pending call; approve for destructive actions, off-hours payments, unknown tools that are explicitly allow-listed for that agent, and degraded scoring; block tools outside the agent allow-list. Default deny. Express **fails closed** (block, `fail_closed_*`) if OPA is unreachable, times out, or answers malformed.

**Approvals.** `POST /api/approvals/:id/decide` is a single conditional `UPDATE … WHERE status='pending'` inside the transaction that also audits and runs/refuses the tool — exactly one concurrent resolver wins, others get 409. A sweeper denies anything older than `APPROVAL_TIMEOUT_SECONDS` (`timeout_denied`) using the DB clock, so restarts neither lose nor double-deny items. With `"wait_for_approval": true` the agent's request blocks (polling the table) until resolution.

**Audit log.** `hash = SHA-256(canonical_json({seq, event_type, payload, created_at, prev_hash}))`, genesis `prev_hash` NULL (hashed as 64 zeros). Appends are serialised by a transaction-scoped advisory lock. Append-only is enforced three ways: no code path, no UPDATE/DELETE/TRUNCATE grant for the app role, and a trigger that rejects UPDATE/DELETE for every role. The verifier detects modified payload/hash/prev_hash, deleted rows (seq gaps) and broken links, and reports the first broken row.

**Live updates.** Triggers `NOTIFY` on inserts/updates; the API `LISTEN`s and relays to authenticated sessions via SSE (`/api/events`). If that channel is unavailable the dashboard shows "Live channel lost — polling every 2.5s" and polls.

## API

All JSON; errors are `{"error":{"code","message","details?"}}`. Agent endpoint: `Authorization: Bearer <agent key>`. Admin endpoints: `ag_session` cookie (HttpOnly, SameSite=Strict) and, for POST, header `x-agentguard-csrf: 1`

| Method & path                                                            | Auth           | Purpose                                                                                                                                                                                    |
| ------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/tool-call`                                                    | agent          | `{tool_name, params, requested_at?, wait_for_approval?}` → 200 allow/block or 202 pending: `{call_id, decision, policy_decision, policy_name, reason, reasons, risk, approval, execution}` |
| `GET /api/tool-calls`                                                    | admin          | `?status=&date_from=&date_to=&page=&page_size=`                                                                                                                                            |
| `GET /api/tool-calls/:id`                                                | admin          | full trail: params, scores + breakdown, OPA decision + reasons, approval, execution, audit rows                                                                                            |
| `GET /api/approvals/pending`                                             | admin          | pending queue with context + expiry                                                                                                                                                        |
| `POST /api/approvals/:id/decide`                                         | admin          | `{decision: "approve"\|"reject"}`; 409 if already resolved/expired                                                                                                                         |
| `GET /api/audit-log`                                                     | admin          | `?page=&page_size=&event_type=&call_id=&focus_seq=`                                                                                                                                        |
| `GET /api/audit-log/head`                                                | admin          | `{seq, hash, created_at, total_rows}`                                                                                                                                                      |
| `GET /api/audit-log/anchor`                                              | bearer token   | `{seq, hash}` only; independent from admin sessions; disabled unless `ANCHOR_TOKEN` is set                                                                                                 |
| `GET /api/audit-log/verify`                                              | admin          | `{valid, status, total_rows, verified_rows, broken_row_id, broken_seq, reason, message}`; 500 `VERIFY_FAILED_TO_RUN` if it could not run                                                   |
| `GET /api/stats`                                                         | admin          | `?range=24h\|7d` counts + time series                                                                                                                                                      |
| `GET /api/demo/scenarios`, `POST /api/demo/trigger/:scenario`            | admin          | canned scenarios: `normal`, `bulk-delete`, `injection`, `unusual-hour-payment`, `burst`                                                                                                    |
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session` | public / admin | session lifecycle                                                                                                                                                                          |
| `GET /api/events`                                                        | admin          | Server-Sent Events (503 → poll)                                                                                                                                                            |
| `GET /health`                                                            | public         | `{status, checks:{database, opa, classifier, realtime}}`                                                                                                                                   |
| `GET /metrics`                                                           | bearer token   | Prometheus metrics; only `METRICS_TOKEN` is accepted; endpoint is disabled unless it is set                                                                                                |

## Environment variables

This table covers every active and optional variable documented in [`.env.example`](.env.example) and [`.env.docker.example`](.env.docker.example). Store real values only in your ignored local `.env` or a deployment secret store. `DATABASE_ADMIN_URL` is for local owner-role tools and the one-off Docker migration/seed service; the running API uses only `DATABASE_URL`.

| Variable(s)                                                          | Used by                                                            | Purpose                                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                       | API, tests                                                         | Application-role database connection.                                                                      |
| `DATABASE_ADMIN_URL`                                                 | Local migrate/seed/reset/tamper/test tools; Docker migrate service | Owner-role connection; never supplied to the running API service.                                          |
| `EMBEDDED_PG_PORT`, `EMBEDDED_PG_USER`, `EMBEDDED_PG_PASSWORD`       | `npm run db:start`                                                 | Local embedded PostgreSQL listener and credentials.                                                        |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`                                 | Docker Compose Postgres and migrate service                        | Compose database owner credentials.                                                                        |
| `APP_DB_USER`, `APP_DB_PASSWORD`                                     | Docker Compose migrate/API services                                | Least-privilege application-role credentials.                                                              |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD`                                   | Setup and seed                                                     | Dashboard login; password is stored hashed in the database.                                                |
| `DEMO_AGENT_API_KEY`                                                 | Seed, demo agent, burst tool                                       | Demo agent credential; the database stores its hash.                                                       |
| `OPA_URL`, `OPA_TIMEOUT_MS`                                          | API and test tooling                                               | OPA endpoint and request timeout.                                                                          |
| `API_HOST`, `API_PORT`, `TRUST_PROXY_HOPS`                           | API/Render                                                         | Bind address, local port override, and number of trusted proxy hops. Render supplies `PORT` automatically. |
| `API_URL`                                                            | Dashboard rewrites/session gate and agent tooling                  | API origin used by the dashboard and SDK examples.                                                         |
| `DASHBOARD_PORT`                                                     | Docker Compose                                                     | Host port mapped to dashboard port 3000.                                                                   |
| `SESSION_TTL_HOURS`, `COOKIE_SECURE`                                 | API                                                                | Admin session lifetime and Secure-cookie setting for HTTPS.                                                |
| `LOG_LEVEL`                                                          | API                                                                | Structured log verbosity.                                                                                  |
| `METRICS_TOKEN`                                                      | API and metrics scraper                                            | Optional bearer token; enables `/metrics`.                                                                 |
| `SENTRY_DSN`                                                         | API                                                                | Optional Sentry reporting; unset disables reporting.                                                       |
| `ANCHOR_TOKEN`                                                       | API and anchor workflow                                            | Optional bearer token for the independent head-only anchor endpoint.                                       |
| `APPROVAL_TIMEOUT_SECONDS`, `APPROVAL_POLL_INTERVAL_MS`              | API                                                                | Approval expiry and polling interval.                                                                      |
| `BUSINESS_HOURS_START`, `BUSINESS_HOURS_END`, `BUSINESS_TIMEZONE`    | API                                                                | Business-hour scoring window; timezone defaults to the host timezone.                                      |
| `INTERNAL_EMAIL_DOMAINS`                                             | API and Docker Compose                                             | Domains treated as internal by the scorer.                                                                 |
| `AGENT_RATE_LIMIT_PER_MINUTE`                                        | API                                                                | In-memory per-agent request limit.                                                                         |
| `INJECTION_MODEL_PATH`                                               | API                                                                | Optional classifier model path override.                                                                   |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `AGENTGUARD_URL`                   | Optional demo agent                                                | LLM credential/model and gateway origin for the unscripted agent.                                          |
| `DASHBOARD_URL`                                                      | Health script                                                      | Optional dashboard URL override for health checks.                                                         |
| `TEST_DATABASE_NAME`, `TEST_DATABASE_URL`, `TEST_DATABASE_ADMIN_URL` | Integration tests                                                  | Optional test database name and connection overrides.                                                      |
| `E2E_DATABASE_NAME`, `E2E_DATABASE_URL`, `E2E_DATABASE_ADMIN_URL`    | E2E tests                                                          | Optional isolated browser-test database overrides.                                                         |

## Troubleshooting

For Prometheus metrics and hosted scraping setup, see [Observability](docs/OBSERVABILITY.md).
For external audit-chain head anchoring, see [Deployment](docs/DEPLOYMENT.md#optional-audit-head-anchoring).

| Symptom                                                      | Fix                                                                                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db:start`: "failed to start" / port in use                  | Another instance is running, or a stale `.data/postgres/postmaster.pid` — stop it or delete that file. Change `EMBEDDED_PG_PORT` if 54329 is taken (update the URLs too). |
| `db:start` fails on Windows as admin                         | Run the terminal as a normal user.                                                                                                                                        |
| API exits "database unreachable or not migrated"             | Start Postgres, run `npm run db:migrate`.                                                                                                                                 |
| Every call is **blocked** with `fail_closed_opa_unavailable` | OPA isn't running/loaded — `npm run opa:start`; `npm run health` confirms. This is the intended fail-closed behaviour.                                                    |
| `db:seed`: "OPA is not reachable"                            | Seeded decisions come from OPA — start it first.                                                                                                                          |
| Dashboard shows "Live channel lost — polling"                | The API's LISTEN connection is down (or you use Supabase's transaction pooler). Data still refreshes every 2.5 s.                                                         |
| Login loops back to /login                                   | `API_URL` must point at the running API; the dashboard validates sessions server-side.                                                                                    |
| Classifier "unavailable" in `/health`                        | `apps/api/models/injection-model.json` missing — restore from git or `npm run ml:setup && npm run ml:train`.                                                              |
| Integration tests: "Cannot reach the test database"          | `npm run db:start` (creates `agentguard_test`), or set `TEST_DATABASE_URL`/`TEST_DATABASE_ADMIN_URL`.                                                                     |
| `npm run demo:tamper` says a tamper is already active        | `npm run demo:tamper -- --restore` first.                                                                                                                                 |

## Known limitations

- **Demo-grade admin auth.** One seeded admin from `.env`; no user management, login throttling, IP-based pre-auth limit, or MFA. Failed login attempts are individually audited; there is no audit-flood aggregation or suppression.
- **Polling, not true async pausing.** The approval "pause" is a held HTTP request polling the approvals table (or a `pending` response); it is not a push-based agent pause.
- **Small classifier and synthetic evaluation.** The selected word-only LogisticRegression was trained on 903 rows in 239 groups; grouped CV and the 30-example challenge results are reported above and in `ml/model/metrics.json`. The 272-case evaluation is hand-written and does not predict performance on real traffic or attacks; it has known benign quoted-SQL and password-policy false positives.
- **Simulated clock in canned scenarios.** Scenario timing signals use a fixed local time so demos are deterministic; this is labelled on every such call. Real agent calls always use server time.
- **Tail truncation.** The local hash-chain check detects edits and broken links. Optional GitHub Actions anchors detect deletion or rewriting up to the latest published head; rows written after that anchor are not yet covered. This protection does not hold if an attacker can rewrite both the database and the `audit-anchors` GitHub branch.
- **Rate-limit scope.** The tool-call limiter runs after agent-key authentication and is in-memory, so it resets on restart and is not shared across replicas. There is no pre-auth IP limiter or admin login throttle. Optional per-agent policy limits use recent persisted calls and are seeded/configured outside a policy-management UI.
- **SQL analysis scope.** SQL risk classification handles comments, statement boundaries, quoted strings/identifiers, mutating CTEs, unbounded mutations, and irreversible DDL, but uses a small hand-written tokenizer rather than a dialect-complete parser. The evaluation suite records benign quoted-SQL false positives; unsupported or novel dialect constructs may still be misclassified.
- **Approval quality.** AgentGuard records the reviewer decision and supports default-deny timeouts, but cannot prevent an authorized reviewer from approving malicious requests without review.
- **Trust in the agent.** AgentGuard executes the (mock) tools itself, so the demo agent cannot run them directly; a different agent with its own real tool access could still bypass the gateway.
- **DB superuser can still tamper** — detectably. Append-only is enforced for the app role and by trigger, but the owner can disable the trigger (that is how the tamper demo works); the verifier is what catches it.
- **Live updates need a session-mode Postgres connection** (no Supabase transaction pooler). The polling fallback covers it.
- **Operational hardening is limited.** The API sets common security headers directly but does not use Helmet; it has no comprehensive production-only secret-strength checks. Deployment operators must set strong credentials, `COOKIE_SECURE=true` behind HTTPS, and protect optional metrics/anchor tokens.
- **Not production:** single instance, no HA, no multi-tenancy, no compliance work, desktop-first UI. Live LLM run untested here without an API key.
