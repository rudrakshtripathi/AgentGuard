# AgentGuard

A policy-enforcement gateway that sits between an AI agent's decision to call a tool and the tool actually running. Every proposed call is **intercepted**, **scored** for risk (rule checklist + a small prompt-injection classifier), **decided by OPA** (allow / block / human approval), **executed only if permitted** (sandboxed mock tools), and **written to a hash-chained, tamper-evident audit log** — all visible live on a dashboard.

This is a time-boxed academic / demo build (single process, single database, no queues). Its limits are stated plainly in [Known limitations](#known-limitations).

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
- Status documents: [`AGENTGUARD_IMPLEMENTATION_STATUS.md`](AGENTGUARD_IMPLEMENTATION_STATUS.md), [`AGENTGUARD_ACCEPTANCE_TEST.md`](AGENTGUARD_ACCEPTANCE_TEST.md), [`AGENTGUARD_FINAL_VERIFICATION.md`](AGENTGUARD_FINAL_VERIFICATION.md)

## Stack

| Layer | Technology |
|---|---|
| Dashboard | Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 |
| API | Node.js · Express 5 · TypeScript (strict) — one process |
| Database | PostgreSQL 17 (local via `embedded-postgres`, or Supabase / any Postgres ≥ 13) |
| Policy | Open Policy Agent 1.21 · Rego v1 |
| Classifier | scikit-learn TF-IDF + LogisticRegression (Python, training only) → JSON → inference in TypeScript |
| Demo agent | OpenAI function calling (`openai` SDK) — the single LLM provider |
| Tests | Vitest · Supertest · Playwright · `opa test` |

## Repository layout

```
apps/api/            Express gateway
  src/interceptor/   pipeline: intercept → score → OPA → act → audit
  src/scoring/       rule scorer, injection classifier inference, score combination
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
policies/            agentguard.rego + agentguard_test.rego
db/migrations/       forward-only SQL migrations
ml/                  dataset generator, hand-written challenge set, training script
e2e/                 Playwright demo-flow suite
scripts/             setup, db-start, opa install/start/test, health, verify, burst, e2e
```

## Setup

### 1. Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Node.js | **≥ 20.11** (developed on 24.19) | everything |
| npm | ≥ 10 (developed on 11.17) | package manager (npm workspaces) |
| Python | 3.10+ (developed on 3.12) | **only** to retrain the classifier — the trained model is committed |
| PostgreSQL | none to install — `npm run db:start` runs a real Postgres 17 locally. Or use Supabase / your own Postgres. | |
| OPA | none to install — `npm run setup` downloads the official binary (SHA-256 verified) into `tools/bin/` | |

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
npm run ml:setup     # creates ml/.venv and installs scikit-learn
npm run ml:train     # regenerates ml/data/injection_dataset.csv, trains, exports apps/api/models/injection-model.json
```

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

## Tests and verification

| Command | What it runs | Needs |
|---|---|---|
| `npm run test:unit` | API unit tests (scoring, hash chain, classifier ↔ sklearn parity, OPA client fail-closed, validation, mock tools) + demo-agent tests | nothing |
| `npm run opa:test` | Rego unit tests with OPA's native test runner | OPA binary |
| `npm run test:integration` | Real pipeline, API contract, security, audit tamper, realtime, 25-call burst — against `agentguard_test` | Postgres + OPA running |
| `npm run test:e2e` | Resets `agentguard_e2e`, builds the dashboard, Playwright runs the demo flow in Chromium (API :4100, dashboard :3100) | Postgres + OPA running |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc` in all workspaces | nothing |
| `npm run demo:burst` | 25 concurrent agent calls against the running API; prints latency + outcomes | API running |
| `npm run audit:verify` | Standalone chain verifier (exit 2 if tampered) | Postgres |
| **`npm run verify`** | **Everything above in order** (starts embedded Postgres / OPA itself if they are not running), then a summary table; non-zero exit on any failure. `-- --skip-e2e` to skip Playwright. | Node; first run of `npm run setup` |

## Demo procedure

Before the demo: `npm run db:reset -- --yes` (fresh, seeded, verifiable history), start Postgres, OPA, API and dashboard, run `npm run health`.

1. **Login** → Overview shows real counts and the calls-over-time chart from seeded history.
2. **/demo → Normal action → Trigger** → *Allowed*, "Mock tool executed". Click **View call**: rule checklist, classifier probability, the OPA rule that fired and why.
3. **/demo → Bulk delete** → *Pending approval*. Open **/approvals**: the card shows target, parameters, risk, OPA reasons and a countdown to default-deny. Click **Approve** → toast "Approved — the action was executed (sandboxed)"; the call detail now shows the reviewer and execution.
4. **/demo → Prompt injection** → *Blocked*, tool not executed; detail shows P(injection) and `block_high_risk_score`.
5. **/demo → Unusual-hour payment** → *Pending* via `approve_financial_off_hours` (evaluated at a simulated 03:14, labelled as such). Reject or approve.
6. **/audit-log → Verify integrity** → PASS.
7. Terminal: `npm run demo:tamper` (flips the decision inside a stored `decision_made` row, as a DB attacker would) → **Verify integrity** → **FAIL at row #N**; "Show row #N" highlights it.
8. `npm run demo:tamper -- --restore` → Verify → PASS.
9. **/demo → Burst of calls** (or `npm run demo:burst`) with **/activity** open: 25 rows stream in live.
10. Optional live, unscripted run (needs `OPENAI_API_KEY`): `npm run agent -- "Delete every file under /srv/reports and email me when done"` — the agent's calls appear live and approval-gated ones wait for you on /approvals.

Canned scenarios never call the LLM. Every scenario pins its evaluation clock (11:14 local; 03:14 for the payment) so outcomes are identical whatever time the demo runs — shown on the call detail as "simulated time".

## How it works

**Interceptor (`apps/api/src/interceptor/pipeline.ts`).** One transaction records `tool_calls` + `call_received`; scoring writes `risk_scores` + `score_computed` (with the full breakdown); OPA is asked; one transaction writes `policy_decisions` + `decision_made` and then either executes the mock tool (`tool_executed`), refuses (`tool_not_executed`) or creates a pending approval (`approval_requested`). Any unexpected error after interception records a fail-closed block. Rejected requests (bad key, malformed JSON, too large, invalid) are audited as `request_rejected`.

**Risk scoring (`src/scoring`).** Deterministic weighted checklist — action type (email 10, query 10, payment 30, delete 35, unknown tool 40), target (missing +15, sensitive +20, external recipient +10), scope (bulk recipients +20, wildcard/recursive delete +25, destructive SQL +30, unbounded DELETE/UPDATE +20, DROP/TRUNCATE +20, sensitive table +15), amount (≥1k +10, ≥10k +25, invalid +15), timing (outside business hours +10, +20 for financial/destructive), frequency (≥15 calls/60 s +10, ≥30 +20); capped at 100. Combination: `final = max(rule, injection)`; classification skipped (no text) → `final = rule` with `injection_score` NULL; classifier unavailable → `final = max(rule, 50)`.

**Classifier (`ml/`).** 807 labelled examples built from hand-written seeds + deterministic templates; TF-IDF word 1–2 grams + logistic regression (C=10, balanced). Held-out templated test split: 99.4 % accuracy (optimistic — templates). **Hand-written challenge set (30, never trained on): 90 %.** Exported to JSON; the TypeScript inference matches sklearn to 1e-9 (tested).

**Policy (`policies/agentguard.rego`).** Bands from the spec: final < 30 allow · 30–70 approve · ≥ 70 block; plus block on injection score ≥ 80 or a duplicate of a pending call; approve for destructive actions, off-hours payments, unknown tools, degraded scoring; default deny. Express **fails closed** (block, `fail_closed_*`) if OPA is unreachable, times out, or answers malformed.

**Approvals.** `POST /api/approvals/:id/decide` is a single conditional `UPDATE … WHERE status='pending'` inside the transaction that also audits and runs/refuses the tool — exactly one concurrent resolver wins, others get 409. A sweeper denies anything older than `APPROVAL_TIMEOUT_SECONDS` (`timeout_denied`) using the DB clock, so restarts neither lose nor double-deny items. With `"wait_for_approval": true` the agent's request blocks (polling the table) until resolution.

**Audit log.** `hash = SHA-256(canonical_json({seq, event_type, payload, created_at, prev_hash}))`, genesis `prev_hash` NULL (hashed as 64 zeros). Appends are serialised by a transaction-scoped advisory lock. Append-only is enforced three ways: no code path, no UPDATE/DELETE/TRUNCATE grant for the app role, and a trigger that rejects UPDATE/DELETE for every role. The verifier detects modified payload/hash/prev_hash, deleted rows (seq gaps) and broken links, and reports the first broken row.

**Live updates.** Triggers `NOTIFY` on inserts/updates; the API `LISTEN`s and relays to authenticated sessions via SSE (`/api/events`). If that channel is unavailable the dashboard shows "Live channel lost — polling every 2.5s" and polls.

## API

All JSON; errors are `{"error":{"code","message","details?"}}`. Agent endpoint: `Authorization: Bearer <agent key>`. Admin endpoints: `ag_session` cookie (HttpOnly, SameSite=Strict) and, for POST, header `x-agentguard-csrf: 1`

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/tool-call` | agent | `{tool_name, params, requested_at?, wait_for_approval?}` → 200 allow/block or 202 pending: `{call_id, decision, policy_decision, policy_name, reason, reasons, risk, approval, execution}` |
| `GET /api/tool-calls` | admin | `?status=&date_from=&date_to=&page=&page_size=` |
| `GET /api/tool-calls/:id` | admin | full trail: params, scores + breakdown, OPA decision + reasons, approval, execution, audit rows |
| `GET /api/approvals/pending` | admin | pending queue with context + expiry |
| `POST /api/approvals/:id/decide` | admin | `{decision: "approve"\|"reject"}`; 409 if already resolved/expired |
| `GET /api/audit-log` | admin | `?page=&page_size=&event_type=&call_id=&focus_seq=` |
| `GET /api/audit-log/verify` | admin | `{valid, status, total_rows, verified_rows, broken_row_id, broken_seq, reason, message}`; 500 `VERIFY_FAILED_TO_RUN` if it could not run |
| `GET /api/stats` | admin | `?range=24h\|7d` counts + time series |
| `GET /api/demo/scenarios`, `POST /api/demo/trigger/:scenario` | admin | canned scenarios: `normal`, `bulk-delete`, `injection`, `unusual-hour-payment`, `burst` |
| `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session` | public / admin | session lifecycle |
| `GET /api/events` | admin | Server-Sent Events (503 → poll) |
| `GET /health` | public | `{status, checks:{database, opa, classifier, realtime}}` |

## Environment variables

See [`.env.example`](.env.example) — every variable is documented there and used by exactly that name.

| Variable | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | API, tests | application role (least privilege) |
| `DATABASE_ADMIN_URL` | migrate, seed, reset, tamper, tests | owner role — never used by the server |
| `EMBEDDED_PG_PORT/USER/PASSWORD` | `db:start` | local Postgres only |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | seed | stored as bcrypt hash |
| `DEMO_AGENT_API_KEY` | seed, demo agent, burst | stored as SHA-256 hash |
| `OPA_URL`, `OPA_TIMEOUT_MS` | API | |
| `API_HOST`, `API_PORT` | API | |
| `API_URL` | dashboard (rewrites + login gate), agent tools | |
| `SESSION_TTL_HOURS`, `COOKIE_SECURE` | API | sessions are random tokens stored hashed — no signing secret is needed |
| `APPROVAL_TIMEOUT_SECONDS`, `APPROVAL_POLL_INTERVAL_MS` | API | |
| `BUSINESS_HOURS_START/END`, `BUSINESS_TIMEZONE` | API | defines "unusual hour" |
| `INTERNAL_EMAIL_DOMAINS`, `AGENT_RATE_LIMIT_PER_MINUTE`, `INJECTION_MODEL_PATH`, `LOG_LEVEL` | API | |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `AGENTGUARD_URL` | demo agent | optional |

## Troubleshooting

| Symptom | Fix |
|---|---|
| `db:start`: "failed to start" / port in use | Another instance is running, or a stale `.data/postgres/postmaster.pid` — stop it or delete that file. Change `EMBEDDED_PG_PORT` if 54329 is taken (update the URLs too). |
| `db:start` fails on Windows as admin | Run the terminal as a normal user. |
| API exits "database unreachable or not migrated" | Start Postgres, run `npm run db:migrate`. |
| Every call is **blocked** with `fail_closed_opa_unavailable` | OPA isn't running/loaded — `npm run opa:start`; `npm run health` confirms. This is the intended fail-closed behaviour. |
| `db:seed`: "OPA is not reachable" | Seeded decisions come from OPA — start it first. |
| Dashboard shows "Live channel lost — polling" | The API's LISTEN connection is down (or you use Supabase's transaction pooler). Data still refreshes every 2.5 s. |
| Login loops back to /login | `API_URL` must point at the running API; the dashboard validates sessions server-side. |
| Classifier "unavailable" in `/health` | `apps/api/models/injection-model.json` missing — restore from git or `npm run ml:setup && npm run ml:train`. |
| Integration tests: "Cannot reach the test database" | `npm run db:start` (creates `agentguard_test`), or set `TEST_DATABASE_URL`/`TEST_DATABASE_ADMIN_URL`. |
| `npm run demo:tamper` says a tamper is already active | `npm run demo:tamper -- --restore` first. |

## Known limitations

- **Demo-grade admin auth.** One seeded admin from `.env`; no user management, no brute-force lockout, no MFA. Disclosed, not hidden.
- **Polling, not true async pausing.** The approval "pause" is a held HTTP request polling the approvals table (or a `pending` response); it is not a push-based agent pause.
- **Small classifier.** ~800 mostly templated examples. 90 % on a 30-example hand-written challenge set; expect worse on real attacks. The rule scorer and policy are the primary signal.
- **Simulated clock in canned scenarios.** Scenario timing signals use a fixed local time so demos are deterministic; this is labelled on every such call. Real agent calls always use server time.
- **Tail truncation.** The hash chain detects edits, deletions in the middle and broken links, but deleting the newest rows leaves a shorter, valid chain. An external anchor (e.g. periodically publishing the head hash) would close this; out of scope.
- **Trust in the agent.** AgentGuard executes the (mock) tools itself, so the demo agent cannot run them directly; a different agent with its own real tool access could still bypass the gateway.
- **DB superuser can still tamper** — detectably. Append-only is enforced for the app role and by trigger, but the owner can disable the trigger (that is how the tamper demo works); the verifier is what catches it.
- **Live updates need a session-mode Postgres connection** (no Supabase transaction pooler). The polling fallback covers it.
- **Not production:** single instance, no HA, no multi-tenancy, no compliance work, desktop-first UI. Live LLM run untested here without an API key.
