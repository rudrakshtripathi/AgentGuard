import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { repoRoot } from '../../src/config.js';

/**
 * Integration tests run against a real PostgreSQL database and a real OPA server.
 * Defaults derive from .env with the database name swapped to `agentguard_test`;
 * override with TEST_DATABASE_URL / TEST_DATABASE_ADMIN_URL / OPA_URL.
 */
const envFile = resolve(repoRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function withDb(url: string | undefined, name: string): string | undefined {
  if (!url) return undefined;
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

export const TEST_DB_NAME = process.env.TEST_DATABASE_NAME ?? 'agentguard_test';
export const testAdminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? withDb(process.env.DATABASE_ADMIN_URL, TEST_DB_NAME);
export const testAppUrl = process.env.TEST_DATABASE_URL ?? withDb(process.env.DATABASE_URL, TEST_DB_NAME);
export const opaUrl = process.env.OPA_URL ?? 'http://127.0.0.1:8181';

export function requireUrls(): { admin: string; app: string } {
  if (!testAdminUrl || !testAppUrl) {
    throw new Error('Integration tests need DATABASE_URL and DATABASE_ADMIN_URL (or TEST_DATABASE_URL / TEST_DATABASE_ADMIN_URL). Run `npm run setup`.');
  }
  return { admin: testAdminUrl, app: testAppUrl };
}
