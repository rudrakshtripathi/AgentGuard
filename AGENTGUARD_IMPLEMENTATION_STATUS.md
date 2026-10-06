# AgentGuard — Implementation Status & Requirements Traceability

Sources of truth: Implementation Plan (PDF), PRD, TRD, Web App Flow, UI/UX Design Spec, Backend & DB Schema spec.
Status values: **Done** = implemented and covered by an executed automated test · **Done (manual)** = implemented, verified by hand only · **Not verified** = implemented but not executed in this environment.

## 0. Starting point (repository audit)

At the start, the repository contained only `README.md` (a plan-level description with placeholder commands). There was no code, no package files, no migrations, no policies, no model, no tests, no Docker files. Toolchain on the build machine: Node 24.19 / npm 11.17 / Python 3.12; **no Postgres, no OPA, no Docker**. Everything below was built from scratch. The original README's structure was kept and rewritten with real commands.

## 1. Functional requirements (PRD §6 / §17)

| ID | Requirement | Status | Implementation | Tests |
|---|---|---|---|---|
| FR-001 | Submit tool call via `POST /api/tool-call`; malformed → 400 + logged; missing key → 401; unknown tool scored conservatively | Done | `apps/api/src/http/routes.ts` (agentRoutes), `interceptor/pipeline.ts` | `pipeline.test.ts`, `security.test.ts` (malformed / 413 / validation all audited), `api.test.ts` |
| FR-002 | Rule-based scoring (action, target, timing, frequency); unknown → conservative default; missing target ≠ zero | Done | `scoring/ruleScorer.ts`, `scoring/toolCatalog.ts` | `scoring.test.ts` (12 cases) |
| FR-003 | Injection classifier; non-text → skipped (NULL); classifier down → cautious | Done | `ml/*.py` (train), `scoring/injectionClassifier.ts` (inference) | `injectionClassifier.test.ts` (sklearn parity 1e-9), `pipeline.test.ts` (NULL score, degraded classifier) |
| FR-004 | Combine scores; documented fallback | Done | `scoring/riskScoring.ts` — `max(rule, injection)`; skipped → rule; unavailable → `max(rule, 50)` | `scoring.test.ts` |
| FR-005 | OPA decision; unmatched → block; OPA unreachable → defined behaviour | Done | `policies/agentguard.rego`, `policy/policyClient.ts` (fail-closed) | `agentguard_test.rego` (21), `policyClient.test.ts` (allow/approve/block + 8 failure modes), `pipeline.test.ts` (OPA down) |
| FR-006 | `approve` → no execution, pending approval; duplicate pending not silently duplicated | Done | `pipeline.ts`; Rego `block_duplicate_pending` | `pipeline.test.ts` |
| FR-007 | Resolve approve/reject; concurrent resolvers get a conflict signal; resolving after timeout | Done | `approvals/approvals.ts` (`resolveApproval`) | `pipeline.test.ts` (5-way race: exactly one 200, four 409, one execution), timeout → 409 |
| FR-008 | Timeout → deny; survives restart without loss/double-deny | Done | `sweepExpiredApprovals` (single atomic UPDATE on DB clock), sweeper runs at startup | `pipeline.test.ts` (timeout, wait-mode timeout) |
| FR-009 | Every event hash-chained; concurrent writes serialised | Done | `audit/hashChain.ts`, `audit/auditLog.ts` (advisory lock, gapless `seq`) | `hashChain.test.ts`, `audit.test.ts` (60 parallel writers) |
| FR-010 | No update/delete path on audit_log | Done (stronger than spec) | no code path + app role has no UPDATE/DELETE/TRUNCATE grant + trigger blocks every role | `audit.test.ts` (app role denied; owner blocked by trigger) |
| FR-011 | Verify chain; first broken row; empty → "nothing to verify"; run-failure distinguishable | Done | `verifyAuditLog`, `GET /api/audit-log/verify`, `npm run audit:verify` | `audit.test.ts` (payload/hash/prev_hash/delete tamper + restore), E2E |
| FR-012 | List/filter calls (status, date), pagination, 400 on bad range | Done | `queries/toolCalls.ts` `listCalls` | `api.test.ts` |
| FR-013 | Call detail; 404; in-progress state | Done | `getCallDetail` (+ breakdown from audit), `/calls/[id]` | `api.test.ts` (in_progress, 404, 400), E2E |
| FR-014 | Pending approvals list; empty state | Done | `listPendingApprovals`, `/approvals` | `api.test.ts`, E2E |
| FR-015 | Stats (total/allowed/blocked/pending) | Done | `getStats` (+ 24h/7d series) | `api.test.ts`, E2E |
| FR-016 | Live updates; degrade to polling, never silently freeze | Done | `db/migrations/002` NOTIFY triggers, `realtime/changeFeed.ts`, `/api/events` SSE, `dashboard/lib/live.tsx` | `scenarios-realtime-perf.test.ts` (0 dropped events, approval insert/update events, 503 fallback), E2E live + fallback |
| FR-017 | Canned scenarios through the real pipeline; unknown → 400 with no partial execution; works without LLM | Done | `demo/scenarios.ts` | `scenarios-realtime-perf.test.ts`, `api.test.ts`, E2E |
| FR-018 | Admin login gate; logout; expiry | Done | `auth/auth.ts`, `dashboard/proxy.ts` (server-validated) | `api.test.ts`, E2E (redirect with `next`, logout) |
| FR-019 | Mock tools executed only after allow/approval | Done | `tools/mockTools.ts`, executed only inside AgentGuard's pipeline/resolution transaction | `pipeline.test.ts`, `misc.test.ts`, `agent.test.ts` |
| FR-020 | Seed data with a valid chain | Done | `devtools/seed.ts` — history goes through the real pipeline + OPA | seed prints "Chain valid"; E2E resets/seeds every run |

## 2. Endpoints (TRD §6)

| Endpoint | Status | Tests |
|---|---|---|
| `POST /api/tool-call` | Done | pipeline, security, API, burst |
| `GET /api/tool-calls`, `GET /api/tool-calls/:id` | Done | API |
| `GET /api/approvals/pending`, `POST /api/approvals/:id/decide` | Done | pipeline, API |
| `GET /api/audit-log`, `GET /api/audit-log/verify` | Done | audit, API |
| `GET /api/stats` | Done | API |
| `POST /api/demo/trigger/:scenario` (+ `GET /api/demo/scenarios`) | Done | scenarios, API |
| `POST /api/auth/login`, `POST /api/auth/logout` (+ `GET /api/auth/session`) | Done | API |
| `GET /api/events` (SSE), `GET /health` | Done (additions: FR-016, TRD §13) | realtime, API |

Every admin endpoint is tested for 401 (no session) and 403 (agent key).

## 3. Database (DB spec §3–§5)

All 8 tables, both enums, FKs with `ON DELETE` rules, UNIQUE 1:1 constraints, `resolved_at_required` CHECK, generated `referenced_call_id`, all listed indexes (+ `event_type`), append-only triggers — `db/migrations/001_initial_schema.sql`. The application role is provisioned by `apps/api/src/db/migrate.ts` with SELECT on all tables, INSERT only where needed, column-level UPDATE only on `approvals(status, reviewer_id, resolved_at)` and `admin_sessions(revoked_at)`, and nothing else. Verified by hand and by `audit.test.ts`.

## 4. UI (UI/UX spec)

| Screen | Status | Notes |
|---|---|---|
| S-01 Login | Done | inline error, loading state, labels, safe `next` redirect |
| S-02 Overview | Done | 4 stat cards ("—" on error), 24h/7d stacked chart with legend, tooltip, table view |
| S-03 Activity | Done | LiveFeedRow, status filter, pagination, highlight-fade on new rows, live indicator |
| S-04 Approvals | Done | ApprovalCard: target, params, risk, OPA reasons, countdown, Approve/Reject, conflict state, toasts |
| S-05 Call Detail | Done | two columns, payload as text, expanded RiskMeter, rule checklist, OPA reasoning, approval, execution, audit trail, in-progress state, context-aware back link |
| S-06 Audit Log | Done | LogTable with chain connectors (pulse while verifying, teal valid, red broken row), truncated + expandable hashes, filter, persistent PASS/FAIL banner, "Show row #N", run-failure shown differently from tampered |
| S-07 Demo | Done | ScenarioTriggerButton cards with inline real results; tamper card with CLI instructions |

Tokens (colours, type scale, spacing, radii, elevation, motion) are in `apps/dashboard/app/globals.css`. Status is always colour + icon + text; timeout-denied is visually distinct from rejected. Accessibility basics: focus ring on everything, H1 focus on navigation, aria-live on verify result/errors, keyboard-operable rows and buttons. Responsive floor at 768/1280.

## 5. Decisions on ambiguities and contradictions

| # | Ambiguity / contradiction | Decision |
|---|---|---|
| 1 | LLM provider (PRD OQ1) | OpenAI, one provider, model via `OPENAI_MODEL`. |
| 2 | Thresholds (OQ3) | Kept the plan's `<30 / 30–70 / ≥70`; RiskMeter uses the same bands. |
| 3 | "Unusual hour" (OQ4) | Outside `[BUSINESS_HOURS_START, BUSINESS_HOURS_END)` (default 07–21) in `BUSINESS_TIMEZONE`. |
| 4 | OPA unreachable (OQ5) | Fail closed: block, `fail_closed_*` policy name, audited. |
| 5 | Missing sub-score (OQ6) | Skipped → rule only (injection NULL); unavailable → floor 50 + `approve_degraded_scoring`. |
| 6 | Dataset source (OQ7) | Self-built: hand-written seeds + deterministic templates (807); separate hand-written challenge set for an honest estimate. |
| 7 | Genesis row (OQ8) | `seq = 1`, `prev_hash` NULL (CHECK-enforced), hashed as 64 zeros. |
| 8 | Concurrent reviewers (OQ9) | Atomic conditional UPDATE; losers get 409 `APPROVAL_ALREADY_RESOLVED`. |
| 9 | Do canned scenarios call the LLM? (OQ10) | No. Fully scripted input, real pipeline. |
| 10 | Plan "API blocks and polls" vs PRD/TRD response `pending` | Both: default returns `pending` (202); `wait_for_approval: true` holds the request and polls the approvals table. Resolution itself is server-side, so nothing depends on the client staying connected. |
| 11 | Who executes mock tools (plan: AgentGuard; TRD: demo agent) | AgentGuard executes them inside the decision/resolution transaction, so "approved" and "executed" cannot diverge and the agent has no execution path. Execution is recorded as `tool_executed` / `tool_not_executed` audit events (no extra table). |
| 12 | Chain order by `created_at` (spec) is ambiguous for same-transaction rows | Added `audit_log.seq` (gapless, UNIQUE); hash also binds `seq` and `created_at`. |
| 13 | Supabase realtime from the browser vs custom auth (DB spec §11, flagged unresolved) | Took the spec's option 2: backend-brokered channel (Postgres NOTIFY → API → SSE, admin-session gated) with polling fallback. The browser never holds a database key. |
| 14 | DB-level append-only (TRD §7 recommended; PRD says app-layer only) | Implemented at DB level (grants + trigger). |
| 15 | Tamper demo vs "no update path" | The app has none; the tamper is an owner-role CLI (`npm run demo:tamper`) that must disable the trigger, as an attacker would. The /demo card explains this. |
| 16 | Agent-supplied `requested_at` | Stored in the audit event as `client_requested_at`; `tool_calls.requested_at` and the timing signal use server time (an agent must not choose its own risk window). |
| 17 | Scenario determinism | Discovered by the E2E suite at 23:45 local: bulk-delete became "block" via off-hours risk. All canned scenarios now pin and label their evaluation clock. Real agent calls always use server time. |
| 18 | `SESSION_SECRET` in the original README | Not needed: sessions are 256-bit random opaque tokens stored as SHA-256; nothing is signed. |
| 19 | Approvals `reviewer` (plan) vs `reviewer_id` (DB spec) | `reviewer_id` FK, per DB spec. |
| 20 | Duplicate pending submission | Policy input carries `duplicate_pending_call_id`; Rego `block_duplicate_pending`. |
| 21 | Next.js 16 renamed `middleware` → `proxy` | Login gate is `apps/dashboard/proxy.ts`. |

## 6. Known gaps / not verified here

- **Live LLM agent run:** `npm run agent` is implemented and its loop is unit-tested with a scripted model and fake gateway, but it was **not executed against OpenAI** (no API key in this environment).
- **Supabase:** developed and tested against PostgreSQL 17 (embedded). The schema uses only standard Postgres features and documented Supabase constraints (session pooler for LISTEN), but it was **not run against a Supabase project** here.
- **Linux / macOS:** developed and tested on Windows 11. The scripts handle other platforms (OPA asset names, embedded-postgres binaries), but they were not executed there.
- Accessibility: built to the spec's checklist but not audited with a screen reader.

See `AGENTGUARD_FINAL_VERIFICATION.md` for the executed results.
