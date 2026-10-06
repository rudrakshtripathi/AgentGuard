#!/usr/bin/env node
// One-time local setup:
//   1. creates .env from .env.example with freshly generated secrets (never overwrites an existing .env)
//   2. downloads + checksum-verifies the OPA binary into tools/bin
//   3. installs Playwright's Chromium (for the E2E suite)
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { rootDir } from './lib/env.mjs';

const envFile = resolve(rootDir, '.env');
if (existsSync(envFile)) {
  console.log('[setup] .env already exists — leaving it untouched');
} else {
  copyFileSync(resolve(rootDir, '.env.example'), envFile);
  const adminPassword = randomBytes(12).toString('base64url');
  const text = readFileSync(envFile, 'utf8')
    .replace('CHANGE_ME_APP_DB_PASSWORD', randomBytes(18).toString('hex'))
    .replace('CHANGE_ME_ADMIN_PASSWORD', adminPassword)
    .replace('ag_CHANGE_ME_GENERATE_WITH_npm_run_setup', `ag_${randomBytes(24).toString('base64url')}`);
  writeFileSync(envFile, text);
  console.log('[setup] created .env with generated secrets');
  console.log(`[setup] dashboard login -> username: admin   password: ${adminPassword}   (stored only in .env)`);
}

const run = (command) => {
  const r = spawnSync(command, { stdio: 'inherit', cwd: rootDir, shell: true });
  if (r.status !== 0) process.exit(r.status ?? 1);
};
run('node scripts/install-opa.mjs');
run('npx playwright install chromium');
console.log('\n[setup] done. Next: npm run db:start (separate terminal), then npm run db:migrate && npm run opa:start ...  (see README)');
