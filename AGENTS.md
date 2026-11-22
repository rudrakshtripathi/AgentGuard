# AGENTS.md

## Project
AgentGuard is a policy-enforcement gateway between an AI agent's decision to call a tool and the tool running. Pipeline: intercept -> risk score (rule checklist + TF-IDF/logistic-regression injection classifier) -> OPA/Rego decision (allow / approve / block) -> execute sandboxed mock tool only if permitted -> write to a SHA-256 hash-chained, append-only audit log. Dashboard shows everything live.

## Layout
- apps/api: Express 5 + TypeScript (strict). Key paths: src/interceptor/pipeline.ts, src/scoring/*, src/policy/*, src/approvals/*, src/audit/*, src/auth/*, src/http/routes.ts, src/tools/*, src/demo/*
- apps/dashboard: Next.js 16 (App Router), React 19, Tailwind 4
- apps/demo-agent: OpenAI function-calling agent that routes tool calls through AgentGuard
- policies/: agentguard.rego and agentguard_test.rego (Rego v1)
- db/migrations/: forward-only SQL migrations
- ml/: Python training code (training only; the trained model JSON is committed)
- e2e/: Playwright; scripts/: setup, db, opa, health, verify helpers

## Commands
- Install: npm install
- Setup (creates .env, downloads OPA): npm run setup
- Typecheck / lint: npm run typecheck, npm run lint
- Unit tests: npm run test:unit
- Policy tests: npm run opa:test
- Integration tests (need Postgres + OPA): npm run test:integration
- E2E: npm run test:e2e
- Everything: npm run verify (add -- --skip-e2e to skip Playwright)

## Definition of done
- npm run typecheck and npm run lint pass.
- npm run test:unit and npm run opa:test pass.
- npm run verify passes, or if the environment cannot run Postgres/OPA, say so explicitly and list what was and was not run.
- New behavior has tests. Security fixes get a regression test that fails before the fix and passes after.

## Hard rules (do not break)
1. Fail closed. Any error, timeout or malformed input in scoring, OPA or the pipeline must result in a block, never an allow.
2. The audit log is append-only. Never add UPDATE/DELETE/TRUNCATE on audit_log, never loosen the grants or the trigger, never change the hash-chain format without a migration plan and explicit instruction.
3. Never edit an existing migration in db/migrations. Add a new numbered migration.
4. OPA/Rego is the single decision authority. Scoring math stays in apps/api/src/scoring, not in Rego.
5. The server never uses DATABASE_ADMIN_URL. Only migrate/seed/reset/tamper/test tooling does.
6. Never read, print, commit or log .env or any secret. Use .env.example for documentation. Never commit real keys or passwords.
7. Do not weaken or delete existing tests to make them pass. If a test is wrong, explain why in the summary.
8. Do not change the mock tools into real tools.
9. Keep TypeScript strict; no any unless justified in a comment.
10. Keep changes small and scoped to the task. Do not refactor unrelated code.

## Style
- Match existing patterns (error handling via AppError, validation via the existing validation module, logging via the existing logger).
- Prefer small pure functions for scoring logic so they are easy to unit test.

## Final answer format
End every task with: (1) files changed, (2) what was verified and the exact commands run with results, (3) anything you could not verify, (4) risks or follow-ups.
