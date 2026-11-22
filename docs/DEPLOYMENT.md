# Free-tier deployment runbook

This deploys the dashboard to Vercel, the API with its OPA sidecar to Render, and PostgreSQL to Supabase. **Provider account creation, password generation, and entering provider secrets are actions only you can do.** Do not put credentials in Git or in this document.

## 1. Create Supabase project and connection strings

**You do this in the Supabase dashboard.** Create a project and save its database password. In **Connect**, select the **Session pooler** (shared pooler, port **5432**). Do not use the Transaction pooler on port 6543: AgentGuard uses PostgreSQL `LISTEN` for live updates, which requires a session connection.

Create two connection URLs using the same session-pooler host, port 5432, and database `postgres`:

- Owner URL: username `postgres.<project-ref>` and the project database password. This becomes `DATABASE_ADMIN_URL` on your local machine only.
- Application URL: username `agentguard_app.<project-ref>` and a new application password. This becomes `DATABASE_URL` locally and on Render. The migration command creates the PostgreSQL role `agentguard_app` with least privilege.

Use the exact host from Supabase's Session pooler details. URL-encode special characters in passwords. Keep these URLs private.

## 2. Migrate and seed from your machine

**You enter the credentials locally.** In your ignored root `.env`, set `DATABASE_ADMIN_URL` to the owner URL and `DATABASE_URL` to the application URL. The variable names and local defaults are documented in [`.env.example`](../.env.example). Install dependencies and OPA if needed, then run:

```bash
npm install
npm run opa:install
npm run db:migrate
npm run db:seed
```

Seeding uses the owner URL to create the demo admin and agent. Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `DEMO_AGENT_API_KEY` in your local `.env` before seeding; use the generated demo credentials for login and scenarios. Do not send `DATABASE_ADMIN_URL` to Render or Vercel. The API process uses only `DATABASE_URL`.

## 3. Deploy API and OPA to Render

**You connect your GitHub account/repository and enter the secret in Render.** In Render, create a Blueprint from this repository and apply [`render.yaml`](../render.yaml). It builds `apps/api/Dockerfile`, exposes the API on Render's supplied `PORT`, and health-checks `/health`. Set the `DATABASE_URL` secret to the application URL. The Blueprint sets `API_HOST=0.0.0.0`, `TRUST_PROXY_HOPS=1`, and `COOKIE_SECURE=true` for Render's TLS reverse proxy. Do not add `DATABASE_ADMIN_URL`.

After deployment, copy the service's HTTPS origin (shown below as `https://<render-service>.onrender.com`) for the dashboard and health monitor. The API trusts one proxy hop so Express recognizes HTTPS from Render's forwarded protocol and emits a Secure session cookie.

## 4. Deploy dashboard to Vercel

**You import the repository and set environment variables in Vercel.** Configure the project as follows:

| Setting                                  | Value                                                |
| ---------------------------------------- | ---------------------------------------------------- |
| Framework preset                         | Next.js                                              |
| Root directory                           | `apps/dashboard`                                     |
| Include files outside the root directory | Enabled                                              |
| Install command                          | `cd ../.. && npm ci`                                 |
| Build command                            | `cd ../.. && npm run build -w @agentguard/dashboard` |
| Output directory                         | Leave the Next.js default                            |

Set `API_URL` to the Render HTTPS origin, without a trailing slash, for each Vercel environment you deploy (Production and Preview as applicable). `apps/dashboard/next.config.ts` uses it for the `/api/*` rewrite, and `apps/dashboard/proxy.ts` uses it for server-side session validation.

The browser calls the dashboard's own `/api/*` paths. The rewrite proxies those requests to the API, so the API's HttpOnly, SameSite=Strict, Secure session cookie is scoped to the Vercel dashboard origin and is sent first-party; the browser does not need a cross-site cookie or direct API CORS access.

## 5. Optional health ping

**You configure a monitor account.** Add an HTTPS GET monitor in UptimeRobot or cron-job.org for `https://<render-service>.onrender.com/health`, at five-minute intervals. A successful response is HTTP 200 with `status: "ok"`. Render's free web services sleep after 15 minutes without inbound traffic and can take about a minute to wake; a ping may keep the service active, but free-tier restarts and resource limits can still cause cold starts or downtime. A cold start can interrupt SSE; the dashboard switches to polling when the stream fails or stops sending events.

## 6. Post-deploy smoke checklist

- Open the Vercel URL, log in using the admin credentials you seeded, and confirm the dashboard loads.
- In **Demo**, trigger each scenario: `normal` (allow), `bulk-delete` (approval), `injection` (block), `unusual-hour-payment` (approval), and `burst` (20–30 calls).
- Open **Approvals** and approve one pending item; confirm its outcome appears.
- Open **Audit Log** and run/confirm chain verification reports valid.
- Open the Render `/health` URL and confirm it returns HTTP 200 and database, OPA, and classifier checks are true. Realtime may be false briefly while the database listener reconnects; the dashboard polling fallback should continue to refresh data.

## Troubleshooting

| Symptom                                           | Check                                                                                                                                                                                                             |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render deploy fails to bind or returns 502        | The Blueprint must retain `API_HOST=0.0.0.0`; Render supplies `PORT`. Review the service logs for startup errors.                                                                                                 |
| Render `/health` returns 503                      | Check the `database`, `opa`, and `classifier` checks. Confirm local migrations completed, Render has the app `DATABASE_URL`, and the OPA sidecar started with the packaged policy.                                |
| Database login or role creation fails             | Use Supabase's Session pooler host on port 5432, database `postgres`, and pooler username including `.<project-ref>`. Check password URL encoding. Run `npm run db:migrate` locally with both URLs.               |
| Dashboard login loops or cookie is missing        | Set Vercel `API_URL` to the Render HTTPS origin without a trailing slash; confirm `/api/*` rewrite works and Render has `COOKIE_SECURE=true`. Visit the dashboard through HTTPS.                                  |
| Live updates stop                                 | Confirm the database URL uses port 5432 rather than transaction pooler 6543. If a platform buffers/cuts SSE or the API wakes, the dashboard should show polling and refresh every 2.5 seconds while reconnecting. |
| An approval remains pending after a sleep/restart | On startup the API immediately sweeps expired pending approvals using an atomic status-conditional update; it records the timeout denial once. Refresh the Approvals page and check the audit log.                |
| First request after inactivity is slow            | This is a Render free-tier wake-up. Add the five-minute health monitor above; it cannot guarantee uptime through platform restarts or quota limits.                                                               |
| Render asks for a secret during Blueprint setup   | Enter only the Supabase application `DATABASE_URL`. The owner `DATABASE_ADMIN_URL` is local migration/seed tooling only and must not be configured on the server.                                                 |

## Optional audit head anchoring

For external protection against newest-row deletion, configure the API's `ANCHOR_TOKEN` and set GitHub repository secrets `ANCHOR_URL` (the API's `/api/audit-log/anchor` URL) and `ANCHOR_TOKEN` (the same token). The scheduled [`anchor.yml`](../.github/workflows/anchor.yml) workflow records the head on the separate `audit-anchors` branch. Give the workflow's GitHub Actions bot permission to create and push that branch. Verify against a downloaded copy of that branch's `docs/anchors.log` or a published raw-file URL with `npm run audit:verify -- --anchors <path-or-URL>`.

**You configure these provider secrets and repository permissions.** The anchor endpoint returns only `seq` and `hash`; it does not require an administrator session.
