#!/usr/bin/env node
// Runs OPA's native policy unit tests: opa test policies -v
import { spawnSync } from 'node:child_process';
import { findOpa, policyDir } from './lib/opa.mjs';

const opa = findOpa();
if (!opa) {
  console.error('OPA not found. Run `npm run opa:install` (or install opa on your PATH).');
  process.exit(1);
}
const check = spawnSync(opa, ['check', '--strict', policyDir], { stdio: 'inherit' });
if (check.status !== 0) process.exit(check.status ?? 1);
const r = spawnSync(opa, ['test', policyDir, '-v'], { stdio: 'inherit' });
process.exit(r.status ?? 1);
