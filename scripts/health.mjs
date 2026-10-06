#!/usr/bin/env node
// npm run health                 -> checks env, model, database, OPA, backend and frontend
// npm run health -- --infra-only -> skips the backend/frontend checks (used by verify)
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { loadEnv, rootDir } from './lib/env.mjs';

loadEnv();
const infraOnly = process.argv.includes('--infra-only');
const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ check: name, status: 'PASS', detail: detail ?? '' });
  } catch (err) {
    results.push({ check: name, status: 'FAIL', detail: err.message });
  }
};
const timeout = (ms) => AbortSignal.timeout(ms);

await check('environment variables', () => {
  const required = ['DATABASE_URL', 'DATABASE_ADMIN_URL', 'OPA_URL', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'DEMO_AGENT_API_KEY'];
  const missing = required.filter((k) => !process.env[k]);
  const placeholders = required.filter((k) => process.env[k]?.includes('CHANGE_ME'));
  if (missing.length) throw new Error(`missing: ${missing.join(', ')} (run npm run setup)`);
  if (placeholders.length) throw new Error(`still placeholders: ${placeholders.join(', ')}`);
  return `${required.length} required present${process.env.OPENAI_API_KEY ? '; OPENAI_API_KEY set' : '; OPENAI_API_KEY not set (only needed for the live agent)'}`;
});

await check('classifier model', () => {
  const p = process.env.INJECTION_MODEL_PATH ?? resolve(rootDir, 'apps/api/models/injection-model.json');
  if (!existsSync(p)) throw new Error(`${p} missing (npm run ml:setup && npm run ml:train)`);
  return p.replace(rootDir, '.');
});

await check('database (app role)', async () => {
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
  await c.connect();
  try {
    const r = await c.query('SELECT (SELECT count(*) FROM tool_calls)::int AS calls, (SELECT count(*) FROM audit_log)::int AS audit');
    return `reachable, migrated (${r.rows[0].calls} calls, ${r.rows[0].audit} audit rows)`;
  } catch (err) {
    throw new Error(`${err.message} (run npm run db:migrate)`, { cause: err });
  } finally {
    await c.end();
  }
});

await check('OPA + agentguard policy', async () => {
  const url = process.env.OPA_URL ?? 'http://127.0.0.1:8181';
  const res = await fetch(`${url}/v1/data/agentguard/policy/result`, { method: 'POST', body: '{"input":{}}', signal: timeout(3000) }).catch(() => {
    throw new Error(`unreachable at ${url} (npm run opa:start)`);
  });
  const body = await res.json();
  if (body?.result?.decision !== 'block') throw new Error('policy not loaded');
  return `${url} (default-deny verified)`;
});

if (!infraOnly) {
  const apiUrl = (process.env.API_URL ?? `http://127.0.0.1:${process.env.API_PORT ?? 4000}`).replace(/\/$/, '');
  await check('backend API', async () => {
    const res = await fetch(`${apiUrl}/health`, { signal: timeout(3000) }).catch(() => {
      throw new Error(`not running at ${apiUrl} (npm run dev:api)`);
    });
    const body = await res.json();
    if (body.status !== 'ok') throw new Error(`degraded: ${JSON.stringify(body.checks)}`);
    return `${apiUrl} ${JSON.stringify(body.checks)}`;
  });
  await check('frontend dashboard', async () => {
    const url = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:3000';
    const res = await fetch(`${url}/login`, { signal: timeout(10_000) }).catch(() => {
      throw new Error(`not running at ${url} (npm run dev:dashboard)`);
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return url;
  });
}

console.table(results);
const failed = results.filter((r) => r.status === 'FAIL').length;
console.log(failed ? `HEALTH: ${failed} check(s) FAILED` : 'HEALTH: all checks passed');
process.exit(failed ? 1 : 0);
