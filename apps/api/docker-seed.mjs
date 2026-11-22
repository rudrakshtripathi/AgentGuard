import { spawn } from 'node:child_process';

const opa = spawn('/usr/local/bin/opa', ['run', '--server', '--addr', '127.0.0.1:8181', '/repo/policies'], {
  stdio: 'inherit',
});
let seed;
let stopping = false;

function stop(code) {
  if (stopping) return;
  stopping = true;
  if (opa.exitCode === null) opa.kill('SIGTERM');
  if (seed && seed.exitCode === null) seed.kill('SIGTERM');
  process.exitCode = code;
}

opa.once('error', (error) => {
  console.error(`[seed] failed to start OPA: ${error.message}`);
  stop(1);
});
opa.once('exit', (code) => {
  if (!stopping) {
    console.error(`[seed] OPA exited before seeding completed (${code ?? 'unknown'})`);
    stop(1);
  }
});
process.once('SIGTERM', () => stop(143));
process.once('SIGINT', () => stop(130));

for (let attempt = 0; attempt < 30; attempt += 1) {
  if (opa.exitCode !== null) break;
  const response = await fetch('http://127.0.0.1:8181/health').catch(() => null);
  if (response?.ok) break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}

if (opa.exitCode !== null) {
  stop(1);
} else {
  seed = spawn('node', ['apps/api/dist/cli/seed.js'], { stdio: 'inherit', env: process.env });
  seed.once('error', (error) => {
    console.error(`[seed] failed to start seed command: ${error.message}`);
    stop(1);
  });
  seed.once('exit', (code, signal) => stop(signal ? 1 : (code ?? 1)));
}
