# Test and Results

Verification date: 2026-11-22.

This report records the local verification evidence for AgentGuard. It documents the latest completed run; it is not a claim that the project has been deployed to external hosting providers.

## Full verification

**Command:** `npm run verify`  
**Result:** PASS

The verification runner completed every configured stage:

| Stage                 | Result | Evidence                                                                                        |
| --------------------- | ------ | ----------------------------------------------------------------------------------------------- |
| TypeScript typecheck  | PASS   | API, dashboard, demo-agent, and SDK workspaces passed.                                          |
| ESLint                | PASS   | `npm run lint` completed without errors.                                                        |
| Unit tests            | PASS   | API: 78 tests; demo-agent: 4 tests; SDK: 4 tests.                                               |
| OPA/Rego tests        | PASS   | 26/26 policy tests passed.                                                                      |
| Database migration    | PASS   | Schema was up to date; application role provisioned with no audit-log UPDATE/DELETE privileges. |
| Integration tests     | PASS   | 60/60 tests passed against embedded PostgreSQL and OPA.                                         |
| Production builds     | PASS   | API, dashboard, demo-agent, and SDK builds completed.                                           |
| Playwright E2E        | PASS   | 13/13 browser tests passed.                                                                     |
| Infrastructure health | PASS   | Database, OPA policy, and classifier checks passed.                                             |

The integration coverage includes metrics-token isolation, audit-head/anchor access, anchored truncation detection, per-agent policy decisions, and expired-approval handling after startup. The browser suite covers login, demo scenarios, approvals, audit tamper detection, live updates and polling fallback.

## Red-team evaluation

**Command:** `npm run eval`  
**Result:** PASS — 272 cases evaluated through the rule scorer and live OPA policy.

| Measure                             | Result |
| ----------------------------------- | -----: |
| Exact decision accuracy             |  97.1% |
| Attack detection (approve or block) |   100% |
| Benign decision false-positive rate |  10.0% |

Confusion matrix (expected decision by actual decision):

| Expected \ Actual | Allow | Approve | Block |
| ----------------- | ----: | ------: | ----: |
| Allow             |    32 |       6 |     2 |
| Approve           |     0 |     108 |     0 |
| Block             |     0 |       0 |   124 |

The evaluation report is generated at `.data/eval-report.json` and is not committed. Eight mismatches are marked `known_failure` in `evals/cases.json` with explanations. Most are classifier escalations of benign SQL wording; one is a benign password-policy email. These synthetic hand-written cases are not a production accuracy estimate and do not cover every possible attack.

## Additional checks

- `git diff --check` — PASS.
- Production dependency audit (`npm audit --omit=dev`) — PASS, 0 vulnerabilities.
- Docker Compose config validation and all image builds — PASS.
- Database reset (`npm run db:reset -- --yes`) — PASS, 3 migrations applied and seeded audit chain verified.
- Prettier check for the README, changed docs, workflows, and Render configuration — PASS.
- Local Markdown link check across the README and documentation — PASS.

## Scope of this evidence

See [Final Verification](AGENTGUARD_FINAL_VERIFICATION.md) for the commit, command-by-command record, Docker build, database reset, local demo coverage, and security scan. These results demonstrate the local tests and builds described above. They do not verify a live Render, Vercel, Supabase, Grafana Cloud, Sentry, or GitHub Actions deployment. Those require provider accounts, credentials, and deployment configuration. See [Deployment](DEPLOYMENT.md) and [Observability](OBSERVABILITY.md) for setup guidance; the deployment runbook also covers audit anchoring.
