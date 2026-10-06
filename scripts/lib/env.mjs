// Minimal shared helpers for the repo-level Node scripts.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Loads ./.env into process.env (existing variables win). */
export function loadEnv() {
  const file = resolve(rootDir, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export const isWindows = process.platform === 'win32';

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Polls `check` until it resolves truthy or the timeout elapses. */
export async function waitFor(check, { timeoutMs = 60_000, intervalMs = 500, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}
