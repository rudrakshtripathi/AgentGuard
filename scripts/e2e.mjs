#!/usr/bin/env node
// E2E runner: resets the isolated agentguard_e2e database (migrate + seed through the real
// pipeline), builds the dashboard against the E2E API port, then runs Playwright, which
// starts the API (:4100) and dashboard (:3100) itself.
// Requires Postgres and OPA to be running (npm run db:start / npm run opa:start).
import { spawnSync } from 'node:child_process';
import { E2E, e2eEnv, root } from '../e2e/env.mjs';

const env = e2eEnv();
const run = (label, command) => {
  console.log(`\n[e2e] ${label}\n$ ${command}`);
  const r = spawnSync(command, { cwd: root, env, stdio: 'inherit', shell: true });
  if (r.status !== 0) {
    console.error(`[e2e] FAILED: ${label}`);
    process.exit(r.status ?? 1);
  }
};

if (!E2E.databaseUrl || !E2E.databaseAdminUrl) {
  console.error('[e2e] DATABASE_URL / DATABASE_ADMIN_URL are not set (run `npm run setup`).');
  process.exit(1);
}
const opa = await fetch(`${E2E.opaUrl}/health`).catch(() => null);
if (!opa?.ok) {
  console.error(`[e2e] OPA is not reachable at ${E2E.opaUrl}. Start it: npm run opa:start`);
  process.exit(1);
}

run('reset + seed the e2e database', 'npx tsx apps/api/src/cli/reset.ts --yes');
if (!process.argv.includes('--skip-build')) run('build the dashboard for the e2e stack', 'npx next build apps/dashboard');
run('run Playwright', `npx playwright test ${process.argv.slice(2).filter((a) => a !== '--skip-build').join(' ')}`);
