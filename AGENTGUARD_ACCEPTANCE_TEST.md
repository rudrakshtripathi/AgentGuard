# AgentGuard — Acceptance Test Matrix

Executed on 2026-10-06/07, Windows 11, Node 24.19, PostgreSQL 17.10 (embedded-postgres), OPA 1.21.1, Chromium (Playwright 1.63).
Every PASS below was **executed**, in three independent runs:
**[A]** `npm run verify` in the working copy · **[C]** `npm run verify` in a clean-room copy (fresh install, no `.env`, no DB, no OPA — started from cold) · **[W]** a scripted walkthrough against the clean-room dev servers (`npm run dev:api` / `dev:dashboard`, admin calls through the dashboard proxy).
Evidence column = the automated test(s) that assert it.

| # | Test | Expected | Actual | Status |
|---|---|---|---|---|
| 1 | Admin login | Valid credentials → session cookie (HttpOnly, SameSite=Strict) → Overview | 200 + cookie flags asserted; browser lands on Overview with real seeded stats. `api.test.ts`, E2E #2, [W] | **PASS** |
| 2 | Invalid login | 401 `INVALID_CREDENTIALS`, inline "Incorrect username or password.", audited | As expected; `admin_login_failed` rows asserted. `api.test.ts`, E2E #2, [W] | **PASS** |
| 3 | Agent authentication | Valid `Bearer ag_…` key accepted on `POST /api/tool-call` only | Accepted; every pipeline test uses it. `pipeline.test.ts`, [W] | **PASS** |
| 4 | Invalid agent key | 401, audited as `request_rejected` | 401 `INVALID_API_KEY` / `AGENT_AUTH_REQUIRED`; audit reasons asserted. `security.test.ts`, [W] | **PASS** |
| 5 | Normal action | allow → mock tool executes | `allow_low_risk_score`, final 10, `executed: true`, 4 audit events in order. `pipeline.test.ts`, scenarios test, E2E #3, [W] | **PASS** |
| 6 | Bulk delete | approve → pending, not executed until a human acts | `approve_destructive_action, approve_medium_risk_score`, final 60, `execution: null`, in queue. Also passes when real time is off-hours (clock-independence test). E2E #4, [W] | **PASS** |
| 7 | Prompt injection | block → not executed, reasoning visible | Blocked; injection 74.5–90 depending on text; reasons shown on detail page. `pipeline.test.ts`, E2E #5, [W] | **PASS** |
| 8 | Unusual-hour payment | approve or block per policy | approve via `approve_financial_off_hours` (+ medium score); simulated 03:14 labelled on detail. scenarios test, E2E #6, [W] | **PASS** |
| 9 | Approval | approved → mock tool executes once, reviewer recorded, audited | `approval_resolved` then `tool_executed`; reviewer shown in UI. `pipeline.test.ts`, E2E #4, [W] | **PASS** |
| 10 | Rejection | rejected → not executed, audited | `tool_not_executed` "Rejected by reviewer admin." `pipeline.test.ts`, E2E #6, [W] | **PASS** |
| 11 | Approval timeout | default deny, `timeout_denied`, no execution; late approve → 409 | As expected, incl. `wait_for_approval` request resolving as a denial. `pipeline.test.ts` | **PASS** |
| 12 | Duplicate approval resolution | exactly one winner, others 409, single execution | 5 concurrent decides → `[200,409,409,409,409]`, one `approval_resolved`, one execution. `pipeline.test.ts`, [W] | **PASS** |
| 13 | Audit verification | PASS on intact chain; "nothing to verify" when empty | PASS (258–300 row chains); empty → `status: empty`. `audit.test.ts`, E2E #7, [W] | **PASS** |
| 14 | Audit tamper detection | Direct DB edit → FAIL identifying the row; restore → PASS | payload / hash / prev_hash / deletion each detected at the right row with the right reason; restore → PASS; UI shows "FAIL — tampered row detected at #N" and highlights the row. `audit.test.ts`, E2E #7, [W] | **PASS** |
| 15 | Activity live update | New call visible without reload | Row appears within 5 s over SSE; burst test: 25/25 inserts delivered, 0 dropped. E2E #8, realtime test | **PASS** |
| 16 | Approval live update | New pending item / resolution visible without reload | Card appears within 5 s; SSE carries approvals insert→update. E2E #9, realtime test | **PASS** |
| 17 | Call detail | payload, scores + breakdown, OPA rule + reasons, approval, execution, audit trail; in-progress state; 404 | All asserted. `api.test.ts`, E2E #3–#5 | **PASS** |
| 18 | Stats | Real counts + time series | 0/0/0/0 on empty DB, then 3/1/1/1 after three calls; 24 hourly / 7 daily buckets. `api.test.ts`, E2E #2 | **PASS** |
| 19 | Demo scenarios | Each runs the real pipeline; unknown → 400 with no partial execution | All five run; every call is a real row attributed to `demo-scenario-runner` with a valid audit chain; unknown → 400, 0 rows. scenarios test, `api.test.ts`, E2E | **PASS** |
| 20 | 20–30 call burst | All succeed, feed keeps up | 25/25 OK; integration avg 463 ms / max 543 ms, 0 dropped live events; `npm run demo:burst` avg 313–373 ms, max 379–428 ms; dashboard responsive after. perf test, E2E #12, [W] | **PASS** |
| 21 | OPA failure | Fail closed: block, not executed, audited | Unreachable / timeout / HTTP 500 / non-JSON / missing result / invalid decision / missing policy_name → all `block` + `fail_closed_*`. Live: OPA stopped under a running API → benign call blocked (`fail_closed_opa_unavailable`), `/health` 503; OPA restarted → recovered. `policyClient.test.ts`, `pipeline.test.ts`, [W] | **PASS** |
| 22 | SQL injection | Payloads stored as inert data; schema intact | Stored verbatim; `audit_log` and `agents` intact; tool_name charset rejects SQL. `security.test.ts` | **PASS** |
| 23 | XSS | Agent input never becomes executable HTML | API returns JSON + nosniff; in the browser the payload renders as text, no `<img>` injected, no dialog fired. `security.test.ts`, E2E #11 | **PASS** |
| 24 | Authorization boundary | agent key → admin endpoint 403; admin session → agent endpoint 401 | Asserted on every admin endpoint; agent cannot approve its own call. `api.test.ts`, `security.test.ts`, [W] | **PASS** |

**Result: 24 / 24 passed.**

### Additional executed checks
| Check | Result |
|---|---|
| OPA native policy tests (`opa check --strict` + `opa test`) | 21/21 PASS |
| Classifier TS inference vs sklearn `predict_proba` (60+ samples) | equal to 1e-9 |
| App DB role cannot UPDATE/DELETE/TRUNCATE `audit_log`, cannot mutate write-once tables | PASS (`audit.test.ts` + manual) |
| Owner role blocked by append-only trigger | PASS |
| 60 concurrent audit appends → gapless valid chain, no shared `prev_hash` | PASS |
| Malformed JSON / 70 KB body / NUL chars / unknown fields → 400/413, each audited | PASS |
| Rate limit → 429, audited | PASS |
| Secrets (API key, password, session token) absent from DB/audit in plaintext | PASS |
| Expired / revoked sessions rejected; logout revokes server-side | PASS |
| Realtime unavailable → `/api/events` 503 → UI shows "polling" and still updates | PASS (integration + E2E #10) |
| Canned scenarios give documented outcomes with real clock outside business hours | PASS |
| Compiled server (`node dist/server.js`) boots healthy | PASS |

### Not executed (honest gaps)
| Item | Why |
|---|---|
| Live OpenAI agent run (`npm run agent`) | No `OPENAI_API_KEY` in this environment. The agent loop is unit-tested with a scripted model; the missing-key path fails with a clear message ([W]). |
| Supabase-hosted database | Not available here; tested on PostgreSQL 17. |
| Linux/macOS | Only Windows 11 was available. |
