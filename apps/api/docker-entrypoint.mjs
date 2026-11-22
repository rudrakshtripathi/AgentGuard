import { spawn } from 'node:child_process';

const opa = spawn('/usr/local/bin/opa', ['run', '--server', '--addr', '127.0.0.1:8181', '/repo/policies'], {
  stdio: 'inherit',
});
const api = spawn('node', ['--env-file-if-exists=/repo/.env', 'apps/api/dist/server.js'], {
  stdio: 'inherit',
  env: process.env,
});
const children = [opa, api];
let stopping = false;

function stop(signal, exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill(signal);
  process.exitCode = exitCode;
}

for (const child of children) {
  child.once('error', (error) => {
    console.error(`[entrypoint] failed to start child: ${error.message}`);
    stop('SIGTERM', 1);
  });
  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`[entrypoint] ${child === opa ? 'OPA' : 'API'} exited (${signal ?? code ?? 'unknown'})`);
      stop('SIGTERM', code && code > 0 ? code : 1);
    }
  });
}

process.once('SIGTERM', () => stop('SIGTERM'));
process.once('SIGINT', () => stop('SIGINT'));
