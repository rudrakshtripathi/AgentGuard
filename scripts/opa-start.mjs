#!/usr/bin/env node
// Runs OPA as a local, internal-only policy server (TRD §14: never on a public port),
// loading ./policies and watching it for changes. Leave running; Ctrl+C stops it.
import { spawn } from 'node:child_process';
import { findOpa, policyDir } from './lib/opa.mjs';
import { loadEnv } from './lib/env.mjs';

loadEnv();
const opa = findOpa();
if (!opa) {
  console.error('OPA not found. Run `npm run opa:install` first.');
  process.exit(1);
}
const url = new URL(process.env.OPA_URL ?? 'http://127.0.0.1:8181');
const addr = `127.0.0.1:${url.port || 8181}`;
console.log(`[opa] serving ${policyDir} on http://${addr}`);
const child = spawn(opa, ['run', '--server', '--addr', addr, '--watch', '--log-level', 'error', policyDir], { stdio: 'inherit' });
const stop = () => child.kill();
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
