# AgentGuard — Final Verification

**Date:** 2026-11-22
**Branch:** `chore/finalize`
**HEAD commit:** `0559b7a8999294820614c0fb7ccee895cd34ba01` (working tree changes are not committed)

## Results

| Command                                                        | Result                                                                                                                                                            |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm install`                                                  | PASS; workspace dependencies installed. The full install reported 9 moderate findings in the dependency tree; see production audit below.                         |
| `npm run typecheck`                                            | PASS; API, dashboard, demo-agent, and SDK.                                                                                                                        |
| `npm run lint`                                                 | PASS.                                                                                                                                                             |
| `npm run test:unit`                                            | PASS; API 78, demo-agent 4, SDK 4 (86 total).                                                                                                                     |
| `npm run opa:test`                                             | PASS; 26/26.                                                                                                                                                      |
| `npm run test:integration`                                     | PASS; 60/60 using local PostgreSQL and OPA.                                                                                                                       |
| `npm run test:e2e`                                             | PASS; 13/13 Playwright/Chromium tests.                                                                                                                            |
| `npm run verify`                                               | PASS; typecheck, lint, unit, OPA, migration, integration, build, E2E, and health stages all passed.                                                               |
| `npm run eval`                                                 | PASS; 272 cases, 97.1% exact decision accuracy, 100% attack detection, 10.0% benign false positives. Eight known failures are explicitly documented in the cases. |
| `npm run db:reset -- --yes`                                    | PASS; recreated 3 migrations, seeded demo records, and verified all 250 audit rows.                                                                               |
| `npm audit --omit=dev`                                         | PASS; 0 production dependency vulnerabilities after compatible lockfile updates.                                                                                  |
| `docker compose --env-file .env.docker.example config --quiet` | PASS.                                                                                                                                                             |
| `docker compose --env-file .env.docker.example build`          | PASS; migrate, API+OPA, and dashboard images built. BuildKit warned that buildx is not installed, then used the Docker driver successfully.                       |
| Markdown relative-link check (README and docs)                 | PASS; 11 Markdown files, no broken relative links.                                                                                                                |
| `git diff --check`                                             | PASS.                                                                                                                                                             |

## Local demo evidence

The database reset completed successfully. The full Playwright walkthrough against the local API, OPA, PostgreSQL, and Chromium stack covered login, allowed mock-tool execution, approval creation and approval, injection blocking, off-hours payment approval, audit verification PASS, controlled tamper verification FAIL, restore verification PASS, and a 25-call burst. The browser suite also verified live updates and polling fallback. These are automated end-to-end checks of the README demo flow; this was not a separate manual operator walkthrough.

## Security and hygiene scan

The credential-pattern scan excluded ignored environment files, dependency folders, and generated output. Matches were synthetic detector/evaluation fixtures and pattern literals; no live credential was identified. Stripe/GitHub-looking unit-test fixtures are assembled from string fragments to avoid push-protection false positives. No TODO/FIXME markers were found. `console.log` occurrences are user-facing output in CLIs and helper scripts; no debugging output was identified in request-handling code. `.gitignore` covers `.env`, `.data`, `tools/bin`, `ml/.venv`, `node_modules`, `.next`, and test artifacts.

## Not verified / external dependencies

- Live deployments on Render, Vercel, Supabase, Grafana Cloud, and Sentry were not exercised; they require account configuration and credentials.
- GitHub Actions workflows were not run on GitHub. `actionlint` is not installed in this environment; Compose and Markdown links were validated locally.
- The optional live OpenAI agent was not run because it requires an external API key.
- The project is an academic demo; see [Known limitations](../README.md#known-limitations) and the [threat model](THREAT_MODEL.md).
