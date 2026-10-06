#!/usr/bin/env node
// Master verification:  npm run verify
//   1 typecheck · 2 lint · 3 unit tests (API + demo agent, incl. sklearn parity)
//   4 OPA policy tests · 5 infrastructure (starts embedded Postgres / OPA if not running)
//   6 integration + API + security + performance tests (real Postgres + OPA)
//   7 production build · 8 E2E (Playwright, isolated stack) · 9 health (infra)
// Every step runs even if an earlier one fails; the summary lists them all and the exit
// code is non-zero if any step failed.  Flags: --skip-e2e
import { spawn, spawnSync } from 'node:child_process';
import pg from 'pg';
import { loadEnv, rootDir, waitFor } from './lib/env.mjs';

loadEnv();
const skipE2E = process.argv.includes('--skip-e2e');
const steps = [];
const children = [];

function run(name, command) {
  console.log(`\n━━━ ${name}\n$ ${command}`);
  const started = Date.now();
  const r = spawnSync(command, { cwd: rootDir, stdio: 'inherit', shell: true, env: process.env });
  const ok = r.status === 0;
  steps.push({ step: name, result: ok ? 'PASS' : 'FAIL', seconds: Math.round((Date.now() - started) / 1000) });
  return ok;
}

async function dbUp() {
  const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL, connectionTimeoutMillis: 2000 });
  try {
    await c.connect();
    return true;
  } catch {
    return false;
  } finally {
    await c.end().catch(() => {});
  }
}
async function opaUp() {
  const r = await fetch(`${process.env.OPA_URL ?? 'http://127.0.0.1:8181'}/health`).catch(() => null);
  return Boolean(r?.ok);
}
function background(script) {
  const child = spawn(process.execPath, [script], { cwd: rootDir, stdio: 'ignore' });
  children.push(child);
  return child;
}

async function ensureInfra() {
  const started = Date.now();
  const notes = [];
  try {
    if (!(await dbUp())) {
      const url = new URL(process.env.DATABASE_ADMIN_URL ?? '');
      if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('remote database unreachable');
      console.log('[verify] starting embedded Postgres...');
      background('scripts/db-start.mjs');
      await waitFor(dbUp, { timeoutMs: 90_000, label: 'Postgres' });
      notes.push('started embedded Postgres');
    }
    if (!(await opaUp())) {
      console.log('[verify] starting OPA...');
      background('scripts/opa-start.mjs');
      await waitFor(opaUp, { timeoutMs: 30_000, label: 'OPA' });
      notes.push('started OPA');
    }
    steps.push({ step: `infrastructure${notes.length ? ` (${notes.join(', ')})` : ''}`, result: 'PASS', seconds: Math.round((Date.now() - started) / 1000) });
    return true;
  } catch (err) {
    console.error(`[verify] infrastructure unavailable: ${err.message}`);
    steps.push({ step: 'infrastructure', result: 'FAIL', seconds: Math.round((Date.now() - started) / 1000) });
    return false;
  }
}

run('typecheck', 'npm run typecheck');
run('lint', 'npm run lint');
run('unit tests', 'npm run test:unit');
run('OPA policy tests', 'npm run opa:test');
if (await ensureInfra()) {
  run('database migrations (dev db)', 'npm run db:migrate');
  run('integration / API / security / performance tests', 'npm run test:integration');
  run('production build', 'npm run build');
  if (skipE2E) steps.push({ step: 'E2E (Playwright)', result: 'SKIPPED', seconds: 0 });
  else run('E2E (Playwright)', 'node scripts/e2e.mjs');
  run('health (infrastructure)', 'node scripts/health.mjs --infra-only');
} else {
  for (const s of ['integration / API / security / performance tests', 'production build', 'E2E (Playwright)', 'health']) steps.push({ step: s, result: 'NOT RUN', seconds: 0 });
}

for (const c of children) c.kill();
console.log('\n━━━ VERIFY SUMMARY');
console.table(steps);
const bad = steps.filter((s) => s.result !== 'PASS' && s.result !== 'SKIPPED');
console.log(bad.length ? `VERIFY FAILED: ${bad.map((s) => s.step).join('; ')}` : 'VERIFY PASSED');
process.exit(bad.length ? 1 : 0);
