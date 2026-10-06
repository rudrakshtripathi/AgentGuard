import { loadConfig } from '../config.js';
import type { Config } from '../config.js';

export function adminUrl(): string {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) {
    console.error('DATABASE_ADMIN_URL is required for this command (owner role: migrations, seeding, demo tamper). See .env.example.');
    process.exit(1);
  }
  return url;
}

export function config(): Config {
  try {
    return loadConfig();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

export function fail(err: unknown): never {
  console.error(`ERROR: ${(err as Error)?.message ?? err}`);
  process.exit(1);
}
