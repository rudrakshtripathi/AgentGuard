import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { rootDir } from './env.mjs';

export const OPA_VERSION = '1.21.1';
export const policyDir = resolve(rootDir, 'policies');

/** Path of the repo-local OPA binary installed by `npm run opa:install`. */
export function opaBinaryPath() {
  return resolve(rootDir, 'tools', 'bin', process.platform === 'win32' ? 'opa.exe' : 'opa');
}

/** Repo-local OPA if installed, otherwise `opa` from PATH, otherwise null. */
export function findOpa() {
  const local = opaBinaryPath();
  if (existsSync(local)) return local;
  try {
    execFileSync('opa', ['version'], { stdio: 'ignore' });
    return 'opa';
  } catch {
    return null;
  }
}
