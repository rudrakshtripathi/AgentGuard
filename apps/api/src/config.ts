import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
/** apps/api directory (works from both src/ and dist/). */
export const apiRoot = resolve(here, '..');
export const repoRoot = resolve(apiRoot, '..', '..');

const systemTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required (application role connection string)'),
  DATABASE_ADMIN_URL: z.string().optional(),
  OPA_URL: z.string().url().default('http://127.0.0.1:8181'),
  OPA_TIMEOUT_MS: z.coerce.number().int().positive().default(1500),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  SESSION_TTL_HOURS: z.coerce.number().positive().default(8),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  APPROVAL_TIMEOUT_SECONDS: z.coerce.number().positive().default(120),
  APPROVAL_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  BUSINESS_HOURS_START: z.coerce.number().int().min(0).max(23).default(7),
  BUSINESS_HOURS_END: z.coerce.number().int().min(1).max(24).default(21),
  BUSINESS_TIMEZONE: z.string().default(systemTimeZone),
  INTERNAL_EMAIL_DOMAINS: z.string().default('acme.example'),
  AGENT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  INJECTION_MODEL_PATH: z.string().default(resolve(apiRoot, 'models', 'injection-model.json')),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
});

export interface Config {
  databaseUrl: string;
  databaseAdminUrl: string | undefined;
  opaUrl: string;
  opaTimeoutMs: number;
  apiHost: string;
  apiPort: number;
  sessionTtlMs: number;
  cookieSecure: boolean;
  approvalTimeoutMs: number;
  approvalPollIntervalMs: number;
  businessHours: { start: number; end: number; timeZone: string };
  internalEmailDomains: string[];
  agentRateLimitPerMinute: number;
  injectionModelPath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid AgentGuard configuration:\n${problems}\nSee .env.example.`);
  }
  const e = parsed.data;
  // Validate the timezone eagerly so a typo fails at startup, not mid-request.
  new Intl.DateTimeFormat('en-US', { timeZone: e.BUSINESS_TIMEZONE });
  return {
    databaseUrl: e.DATABASE_URL,
    databaseAdminUrl: e.DATABASE_ADMIN_URL || undefined,
    opaUrl: e.OPA_URL.replace(/\/$/, ''),
    opaTimeoutMs: e.OPA_TIMEOUT_MS,
    apiHost: e.API_HOST,
    apiPort: e.API_PORT,
    sessionTtlMs: e.SESSION_TTL_HOURS * 3_600_000,
    cookieSecure: e.COOKIE_SECURE,
    approvalTimeoutMs: e.APPROVAL_TIMEOUT_SECONDS * 1000,
    approvalPollIntervalMs: e.APPROVAL_POLL_INTERVAL_MS,
    businessHours: { start: e.BUSINESS_HOURS_START, end: e.BUSINESS_HOURS_END, timeZone: e.BUSINESS_TIMEZONE },
    internalEmailDomains: e.INTERNAL_EMAIL_DOMAINS.split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
    agentRateLimitPerMinute: e.AGENT_RATE_LIMIT_PER_MINUTE,
    injectionModelPath: e.INJECTION_MODEL_PATH,
    logLevel: e.LOG_LEVEL,
  };
}
