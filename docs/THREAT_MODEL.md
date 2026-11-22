# Threat model

This is a threat model for the current AgentGuard repository, an academic demonstration that gates sandboxed mock tool calls. It does not claim to secure real tools that run outside the gateway.

## Assets

- Agent API keys, administrator passwords, and session tokens.
- Tool-call parameters, classifier/rule scores, policy inputs, and execution outcomes.
- Pending approvals and reviewer decisions.
- The append-only audit rows, their sequence/hash chain, and externally published audit-head anchors.
- Database, OPA policy, and optional observability credentials.

## Trust boundaries

1. **Agent to API:** agent-controlled JSON crosses authentication, validation, scoring, and rate limits in `apps/api/src/http/routes.ts` and `apps/api/src/auth/auth.ts`.
2. **API to OPA:** the API sends a policy input to the OPA service; OPA is the single decision authority (`apps/api/src/policy/policyClient.ts`, `policies/agentguard.rego`).
3. **API to PostgreSQL:** the API uses the least-privilege application role; migrations, seeding, and maintenance use a separate owner URL (`apps/api/src/db/pool.ts`, `apps/api/src/db/migrate.ts`).
4. **Browser to dashboard/API:** the dashboard validates the session server-side and rewrites same-origin `/api/*` requests (`apps/dashboard/proxy.ts`, `apps/dashboard/next.config.ts`).
5. **Human approver to API:** reviewers act through authenticated, CSRF-protected admin routes (`apps/api/src/auth/auth.ts`, `apps/api/src/http/routes.ts`).
6. **API to anchor repository:** the anchor workflow uses a separate bearer token to read only the head sequence/hash, then publishes a timestamped line to `audit-anchors` (`apps/api/src/http/routes.ts`, `.github/workflows/anchor.yml`).

## Attacker types

- **Malicious prompt/content:** tries to make an agent perform unauthorized or exfiltrating actions.
- **Compromised or malicious agent:** submits hostile tool calls using its own API key, or tries to bypass the gateway if it has a direct tool path.
- **Network attacker:** attempts to intercept or replay credentials and sessions.
- **Database owner:** can inspect data and may disable database triggers or rewrite rows with elevated database privileges.
- **Malicious or careless approver:** approves an unsafe request, intentionally or without adequate review.
- **Compromised OPA or deployment operator:** can alter policy behavior or deployment secrets/configuration.

## STRIDE-style threats and existing mitigations

| STRIDE                 | Threat                                             | Mitigations in this repository                                                                                                                                                                                                                                                                                            | Residual risk                                                                                                                                                                          |
| ---------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spoofing               | Stolen agent key impersonates an agent             | Agent keys are stored as SHA-256 hashes and checked by `apps/api/src/auth/auth.ts`; per-agent policy is loaded by agent ID in `apps/api/src/interceptor/pipeline.ts`.                                                                                                                                                     | A stolen key can submit calls within that agent's authority until rotated; there is no self-service rotation UI.                                                                       |
| Spoofing               | Stolen dashboard session impersonates an admin     | Random session tokens are stored hashed, cookies are HttpOnly/SameSite, and CSRF is checked for decisions (`apps/api/src/auth/auth.ts`). Production proxy settings can enable Secure cookies (`apps/api/src/config.ts`, `apps/api/src/app.ts`).                                                                           | The demo has one seeded admin, no MFA, and no account lockout. A stolen admin session can approve calls.                                                                               |
| Tampering              | Agent manipulates scores or policy input           | The server constructs scores and policy input from validated request data and stored per-agent limits (`apps/api/src/interceptor/pipeline.ts`, `apps/api/src/policy/policyClient.ts`). OPA fails closed on malformed/unavailable responses (`apps/api/src/policy/policyClient.ts`).                                       | Compromised API code, policy bundle, or deployment can alter this path.                                                                                                                |
| Tampering              | Audit rows are edited or deleted                   | Hashes bind sequence, event, payload, timestamp, and previous hash (`apps/api/src/audit/hashChain.ts`). The append-only trigger and restricted application grants are created in `db/migrations/001_initial_schema.sql` and provisioned by `apps/api/src/db/migrate.ts`.                                                  | A database owner can disable triggers and remove the newest rows; the local chain alone cannot detect a valid shortened tail. Published anchors detect loss through the latest anchor. |
| Repudiation            | An actor denies a call or decision                 | Pipeline events and approval resolution are appended to the hash chain (`apps/api/src/interceptor/pipeline.ts`, `apps/api/src/approvals/approvals.ts`, `apps/api/src/audit/auditLog.ts`). Anchors can publish the head outside the database (`.github/workflows/anchor.yml`).                                             | The anchor interval leaves a window, and an attacker who controls both the database and anchor branch can rewrite both records.                                                        |
| Information disclosure | Agent reads another agent's or admin's data        | Admin routes require an admin session, agent routes require a bearer key, and dashboard page checks call the API server-side (`apps/api/src/http/routes.ts`, `apps/api/src/auth/auth.ts`, `apps/dashboard/proxy.ts`).                                                                                                     | Administrator views intentionally include raw tool-call parameters and audit details. A compromised admin account can read them.                                                       |
| Information disclosure | Secrets leak through metrics or error reporting    | Metrics use fixed tool/status labels and a separate bearer token (`apps/api/src/metrics.ts`, `apps/api/src/app.ts`). Optional Sentry events remove request data, extras, headers/cookies, breadcrumbs, and exception messages (`apps/api/src/sentry.ts`).                                                                 | Metrics and Sentry credentials still need secure handling; the audit log intentionally stores call parameters for review.                                                              |
| Denial of service      | Agent floods the API or submits oversized requests | Per-agent in-memory rate limiting, JSON size limits, schema validation, and OPA timeouts are applied in `apps/api/src/http/routes.ts` and `apps/api/src/config.ts`.                                                                                                                                                       | In-memory rate limits reset on restart and are not coordinated across replicas; an upstream volumetric attack remains a hosting/network concern.                                       |
| Elevation of privilege | A tool call exceeds an agent's authority           | Rego blocks tools outside each agent's allow-list, payments above its cap, calls above its configured recent-call limit, and emails to disallowed domains (`policies/agentguard.rego`). App role reads the policy table but cannot alter it (`db/migrations/003_agent_policies.sql`, `apps/api/src/db/migrate.ts`).       | Seeded policy values have no admin management UI; operators must provision them through trusted tooling/database access.                                                               |
| Elevation of privilege | Agent executes a tool without review               | OPA precedence makes block rules override approval and allow; destructive actions require approval, and the actual tool executor is a fixed mock catalog (`policies/agentguard.rego`, `apps/api/src/tools/mockTools.ts`). The SDK fails closed if the gateway cannot be reached (`packages/agentguard-sdk/src/index.ts`). | An agent that also has direct access to real tools can bypass this gateway. This repository does not revoke those external capabilities.                                               |

## Mitigations added by recent hardening work

- SQL comments, quotes, statement boundaries, destructive CTEs, and uncertain parsing are analyzed conservatively in `apps/api/src/scoring/sqlAnalysis.ts`.
- Sensitive values are classified by kind without copying secret values into score labels in `apps/api/src/scoring/sensitiveData.ts` and `apps/api/src/scoring/ruleScorer.ts`.
- Expired approvals are swept on startup with a conditional update, so concurrent/restarted sweepers resolve each pending item once (`apps/api/src/approvals/approvals.ts`).
- SSE heartbeats and a dashboard watchdog move clients to polling if a proxy buffers or cuts the stream (`apps/api/src/http/routes.ts`, `apps/dashboard/lib/live.tsx`).
- Optional Prometheus scraping is token-protected and excludes caller-controlled metric labels (`apps/api/src/metrics.ts`, `apps/api/src/app.ts`).
- Optional Sentry reporting scrubs request-associated fields before transmission (`apps/api/src/sentry.ts`).
- Optional audit anchors are independently token-protected and can detect truncation through the published head (`apps/api/src/audit/anchors.ts`, `apps/api/src/audit/auditLog.ts`, `.github/workflows/anchor.yml`).
- The red-team suite measures the rule scorer and actual OPA policy without tuning thresholds to its cases (`evals/cases.json`, `apps/api/src/cli/eval.ts`).
- The SDK only returns gateway execution objects; the SDK callback is never called in the agent process (`packages/agentguard-sdk/src/index.ts`).

## Residual risks and assumptions

- The threat model assumes the agent has no alternate direct access to a real tool. If it does, AgentGuard cannot mediate that access.
- A malicious or rubber-stamping authorized approver can approve a harmful action; the software records the decision but cannot judge human intent.
- The API, OPA policy, database owner, GitHub anchor repository, and hosting configuration remain trusted administrative components.
- Anchoring protects only through the most recently published point. It does not cover later rows, and it cannot withstand one attacker controlling both the database and anchor repository.
- The SQL tokenizer, sensitive-data scanner, and classifier are not complete semantic analyzers. Evaluation scores apply only to the current hand-written cases.
- All tools shipped in this repository are mock tools. No claim is made that a real tool execution environment has the same isolation properties.
