// Isolated E2E stack: its own database (agentguard_e2e), API on :4100, dashboard on :3100.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Loaded both as ESM (scripts/e2e.mjs) and transpiled to CJS (Playwright config), so the
// repo root is found by walking up from the working directory rather than import.meta.
function findRoot(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(resolve(d, 'playwright.config.ts'))) return d;
    if (dirname(d) === d) throw new Error('Run the E2E suite from inside the AgentGuard repository.');
  }
}
export const root = findRoot(process.cwd());
if (existsSync(resolve(root, '.env'))) process.loadEnvFile(resolve(root, '.env'));

function withDb(url, name) {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

const DB = process.env.E2E_DATABASE_NAME ?? 'agentguard_e2e';
export const E2E = {
  apiPort: 4100,
  webPort: 3100,
  admin: { username: 'e2e-admin', password: 'e2e-admin-password-123' },
  agentKey: 'ag_e2e_agent_key_0123456789abcdefghij',
  databaseUrl: process.env.E2E_DATABASE_URL ?? (process.env.DATABASE_URL ? withDb(process.env.DATABASE_URL, DB) : ''),
  databaseAdminUrl: process.env.E2E_DATABASE_ADMIN_URL ?? (process.env.DATABASE_ADMIN_URL ? withDb(process.env.DATABASE_ADMIN_URL, DB) : ''),
  opaUrl: process.env.OPA_URL ?? 'http://127.0.0.1:8181',
  tamperBackup: resolve(root, '.data', 'e2e-tamper-backup.json'),
};

/** Environment for every E2E process (API, seed, tamper CLI, Next build/start). */
export function e2eEnv() {
  return {
    ...process.env,
    DATABASE_URL: E2E.databaseUrl,
    DATABASE_ADMIN_URL: E2E.databaseAdminUrl,
    OPA_URL: E2E.opaUrl,
    API_PORT: String(E2E.apiPort),
    API_HOST: '127.0.0.1',
    API_URL: `http://127.0.0.1:${E2E.apiPort}`,
    ADMIN_USERNAME: E2E.admin.username,
    ADMIN_PASSWORD: E2E.admin.password,
    DEMO_AGENT_API_KEY: E2E.agentKey,
    APPROVAL_TIMEOUT_SECONDS: '300',
    LOG_LEVEL: 'warn',
    NEXT_DIST_DIR: '.next-e2e',
    TAMPER_BACKUP_FILE: E2E.tamperBackup,
    NEXT_TELEMETRY_DISABLED: '1',
  };
}
