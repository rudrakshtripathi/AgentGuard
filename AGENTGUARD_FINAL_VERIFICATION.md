# AgentGuard — Final Verification Report

**Status: PASS WITH LIMITATIONS.** The full critical path works end to end and every automated suite passes, including a clean-room install from scratch. Limitations: the live OpenAI agent run, Supabase hosting and non-Windows platforms were not executed here (see §20/§23).

## 1. Architecture implemented

One Express process (`apps/api`) containing the Interceptor, Risk Scoring, OPA Policy Client, Approval workflow, Audit log, Auth, Demo scenario runner and a realtime relay. OPA runs as a localhost-only sidecar. PostgreSQL holds the operational tables and the hash-chained audit log. A Next.js dashboard talks to the API only through same-origin `/api/*` rewrites. The demo agent is a separate CLI that proposes tool calls to AgentGuard. No queue, no Redis, no microservices.

```
agent ─► POST /api/tool-call ─► auth ─► tool_calls ─► scoring ─► risk_scores ─► OPA ─► policy_decisions
                                                                         ├ allow   ─► mock tool runs ─► audit
                                                                         ├ block   ─► not run ────────► audit
                                                                         └ approve ─► approvals(pending) ─► dashboard ─► human
                                                                                         ├ approve ─► runs ─► audit
                                                                                         └ reject/timeout ─► not run ─► audit
audit_log (SHA-256 chain) ─► verifier (API, CLI, dashboard)      Postgres NOTIFY ─► API ─► SSE ─► dashboard (poll fallback)
```

## 2. Features implemented
All 20 PRD functional requirements — see the traceability table in `AGENTGUARD_IMPLEMENTATION_STATUS.md` §1. All 11 specified endpoints plus `/api/auth/session`, `/api/demo/scenarios`, `/api/events`, `/health`. All 7 screens and the 7 named components.

## 3. Files / modules created
| Area | Files |
|---|---|
| Root | `package.json` (npm workspaces), `.env.example`, `.gitignore`, `eslint.config.mjs`, `playwright.config.ts`, `README.md`, the three `AGENTGUARD_*.md` reports |
| Database | `db/migrations/001_initial_schema.sql`, `002_change_notifications.sql` |
| Policy | `policies/agentguard.rego`, `policies/agentguard_test.rego` |
| ML | `ml/generate_dataset.py`, `ml/train.py`, `ml/requirements.txt`, `ml/data/injection_dataset.csv`, `ml/data/challenge_set.csv`, `ml/model/metrics.json` |
| API | `apps/api/src/{config,logger,context,app,server}.ts`, `db/{pool,migrate,reset}.ts`, `http/{errors,validation,routes}.ts`, `auth/auth.ts`, `interceptor/pipeline.ts`, `scoring/{toolCatalog,ruleScorer,injectionClassifier,riskScoring}.ts`, `policy/policyClient.ts`, `approvals/approvals.ts`, `audit/{hashChain,auditLog}.ts`, `tools/mockTools.ts`, `demo/scenarios.ts`, `realtime/changeFeed.ts`, `queries/toolCalls.ts`, `devtools/{seed,tamper}.ts`, `cli/{common,migrate,seed,seedRunner,reset,verify-audit,tamper}.ts`, `models/injection-model.json`, `models/injection-parity.json` |
| API tests | `test/unit/{hashChain,scoring,injectionClassifier,policyClient,misc}.test.ts`, `test/integration/{env,globalSetup,harness}.ts`, `test/integration/{pipeline,audit,api,security,scenarios-realtime-perf}.test.ts`, `vitest.config.ts` |
| Dashboard | `apps/dashboard/{next.config.ts,proxy.ts,postcss.config.mjs,tsconfig.json}`, `app/{layout.tsx,globals.css,login/page.tsx}`, `app/(dashboard)/{layout,page}.tsx` + `activity`, `approvals`, `calls/[id]`, `audit-log`, `demo` pages, `components/{StatusBadge,RiskMeter,ApprovalCard,LogTable,IntegrityCheckButton,ScenarioTriggerButton,LiveFeedRow,CallsChart,HashValue,Shell,Toast,ui,icons}.tsx`, `lib/{api,live,types,format}.ts(x)` |
| Demo agent | `apps/demo-agent/src/{agent,openaiLlm,cli,agent.test}.ts` |
| Scripts | `scripts/{setup,db-start,install-opa,opa-start,opa-test,ml,health,burst,e2e,verify}.mjs`, `scripts/lib/{env,opa}.mjs` |
| E2E | `e2e/env.mjs`, `e2e/demo-flow.spec.ts` |

## 4. Database setup
PostgreSQL 17 via `npm run db:start` (or any Postgres ≥ 13 / Supabase). `npm run db:migrate` applies the two forward-only migrations and provisions `agentguard_app` from `DATABASE_URL` with least privilege (no UPDATE/DELETE/TRUNCATE on `audit_log`; write-once tables INSERT-only; column-level UPDATE only on `approvals` and `admin_sessions.revoked_at`). Verified by attempting each forbidden statement as the app role.

## 5. OPA setup
`npm run setup` (or `npm run opa:install`) downloads OPA 1.21.1 and verifies its SHA-256 against the release checksum. `npm run opa:start` serves `./policies` on 127.0.0.1:8181. The Express client fails closed on every OPA error mode.

## 6. Risk scoring
Weighted checklist (`apps/api/src/scoring/ruleScorer.ts`, documented in the file header and README); `final = max(rule, injection)`; skipped → rule only (injection NULL); classifier unavailable → `max(rule, 50)`. The full breakdown is stored in the hash-chained `score_computed` event and shown on the call detail page.

## 7. Classifier
TF-IDF (word 1–2 grams) + LogisticRegression (C=10, class-balanced), scikit-learn 1.9.1. Dataset: 807 examples (427 benign / 380 injection). Held-out templated split: accuracy 0.994. **Hand-written challenge set (30, never trained on): accuracy 0.90, precision 0.93, recall 0.87.** TypeScript inference equals sklearn to 1e-9. Demonstration-scale, not production-grade. Retrain: `npm run ml:setup && npm run ml:train`.

## 8. Authentication
Agents: `Bearer ag_…` keys, SHA-256 at rest, accepted only by `POST /api/tool-call`. Admins: bcrypt (cost 12) passwords seeded from `.env`; 256-bit random session tokens stored as SHA-256 with expiry and revocation; HttpOnly SameSite=Strict cookie; CSRF header required on admin POSTs; dashboard pages gated server-side by `proxy.ts`.

## 9. Approval workflow
Pending approvals created atomically with the OPA decision. Single-winner conditional UPDATE resolves and executes or refuses in the same transaction. A timeout sweeper (DB clock, runs at startup and every second) denies expired items. Optional blocking mode (`wait_for_approval`) polls the approvals table.

## 10. Audit log
`SHA-256(canonical_json({seq, event_type, payload, created_at, prev_hash}))`, genesis `prev_hash` NULL. Advisory-lock-serialised appends. Append-only through code, grants and trigger. The verifier (API, `npm run audit:verify`, dashboard) reports the first broken row and the reason: hash mismatch, broken link, or missing rows.

## 11. Dashboard
Seven screens per the UI spec's "Signal & Ledger" tokens. Live via SSE with a visible polling fallback. Hashes are truncated with full value on click/focus. Status is shown as colour + icon + text. Agent content is rendered only as text (no `dangerouslySetInnerHTML` anywhere).

## 12. Demo scenarios
`normal` → allow · `bulk-delete` → approve · `injection` → block · `unusual-hour-payment` → approve (off-hours financial) · `burst` → 25 concurrent calls · tamper → `npm run demo:tamper` / `-- --restore` (owner-role CLI by design). Scenarios use the real pipeline and pin and label their evaluation clock so outcomes are time-of-day independent.

## 13–19. Test results (executed)

| Suite | Command | Working copy [A] | Clean room [C] |
|---|---|---|---|
| Typecheck (3 workspaces) | `npm run typecheck` | PASS | PASS |
| Lint | `npm run lint` | PASS (after fixing ignore list — see §23) | PASS |
| Unit — API | `npm run test:unit` | 68/68 | 68/68 |
| Unit — demo agent | (same) | 4/4 | 4/4 |
| OPA policy | `npm run opa:test` | 21/21 | 21/21 |
| Integration + API + security + performance | `npm run test:integration` | 54/54 | 54/54 |
| Production build (api, dashboard, demo-agent) | `npm run build` | PASS | PASS |
| E2E (Playwright, Chromium) | `npm run test:e2e` | 13/13 | 13/13 |
| Health (infra) | `npm run health -- --infra-only` | PASS | PASS |
| **Master** | `npm run verify` | **VERIFY PASSED** (after the lint fix) | **VERIFY PASSED** from cold (it started its own Postgres + OPA) |

Breakdown of the 54 integration tests: pipeline 13 (all decision paths, race, duplicates, timeout, blocking wait, OPA down, classifier down), audit 10 (mandatory tamper test + 4 tamper modes + grants + trigger + concurrency + empty + pagination), API contract 13, security 12, scenarios/realtime/performance 6.

**Performance (§18):** 25 concurrent calls — integration run: 25/25 OK, avg 463 ms, max 543 ms, 0 of 25 live events dropped; `npm run demo:burst` against dev servers: avg 313–373 ms, max 379–428 ms, 0 failures. Dashboard remained responsive (stats in < 1 s after the burst; E2E burst test passed).

**Clean-room manual walkthrough [W]** (fresh copy → `npm install` → `npm run setup` → `db:start` → `db:migrate` → `opa:start` → `db:seed` → `dev:api` → `dev:dashboard` → `npm run health` all PASS) → 21/21 scripted steps PASS: invalid/valid login through the dashboard proxy, unauthenticated redirect, normal/bulk/approve/409/injection/payment/reject, activity + detail, verify PASS → `npm run demo:tamper` → FAIL at #281 → restore → PASS (+ standalone verifier), `npm run demo:burst` 25/25, responsiveness, all three auth boundaries, demo agent without key fails clearly, logout. Then OPA stopped under the live API → benign call **blocked** `fail_closed_opa_unavailable`, `/health` 503 → OPA restarted → recovered.

## 20. Known limitations
Demo-grade single admin; polling-based approval pause; small classifier (90 % on challenge set); simulated clock in canned scenarios (labelled); tail truncation of the chain not detectable without an external anchor; DB owner can still tamper (detectably); live updates need a session-mode connection; single instance; desktop-first. Full list: README → Known limitations.

## 21. Commands to run
```bash
npm install
npm run setup                 # .env with generated secrets, OPA binary, Playwright Chromium
npm run db:start              # terminal 1
npm run opa:start             # terminal 2
npm run db:migrate
npm run db:seed               # or: npm run db:reset -- --yes
npm run dev:api               # terminal 3  → http://127.0.0.1:4000
npm run dev:dashboard         # terminal 4  → http://localhost:3000  (login: ADMIN_USERNAME / ADMIN_PASSWORD in .env)
```

## 22. Commands to verify
```bash
npm run verify                # everything; starts Postgres/OPA itself if needed
npm run health                # with services running
npm run demo:burst            # 25-call burst against the running API
npm run demo:tamper           # then Verify integrity → FAIL;  npm run demo:tamper -- --restore → PASS
npm run audit:verify          # standalone chain verifier
```

## 23. Remaining failures and issues found during verification
**No remaining test failures.** Issues found by testing and fixed during this work:
1. The E2E suite, run at 23:45 local, showed the bulk-delete scenario blocked instead of routed to approval (off-hours risk). Fixed: canned scenarios pin and label their evaluation clock; a regression test runs them with the real clock outside business hours.
2. Postgres `jsonb` reorders keys, which changed the classifier score of the same call when re-read. Fixed: text extraction visits keys in sorted order (tested).
3. Classifier feature leakage: `.example` email addresses appeared only in injection examples, so benign emails scored up to 0.38. Fixed in the dataset; benign samples now score 0.02–0.11.
4. `DROP TABLE users` landed in the human-review band. Added an irreversible-DDL factor (+20), which moves it into the block band.
5. Tailwind 4 auto-detection scanned a build artifact and emitted invalid CSS (dashboard HTTP 500). Fixed with explicit `@source` paths.
6. Lint scanned the E2E build directory (`.next-e2e`). Fixed the ignore list. The first `npm run verify` in the working copy reported FAILED (lint only); after the fix both lint and the clean-room `verify` pass.

Not executed: live OpenAI agent run (no key), Supabase-hosted DB, Linux/macOS.
