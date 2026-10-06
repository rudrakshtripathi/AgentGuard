import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { Config } from '../../src/config.js';
import type { AppContext } from '../../src/context.js';
import { createPool } from '../../src/db/pool.js';
import type { Db } from '../../src/db/pool.js';
import { truncateAll } from '../../src/db/reset.js';
import { createLogger } from '../../src/logger.js';
import { createOpaPolicyClient } from '../../src/policy/policyClient.js';
import type { PolicyClient } from '../../src/policy/policyClient.js';
import { loadClassifier } from '../../src/scoring/injectionClassifier.js';
import { createChangeFeed } from '../../src/realtime/changeFeed.js';
import { seedIdentities } from '../../src/devtools/seed.js';
import { opaUrl, requireUrls } from './env.js';

export const ADMIN = { username: 'admin', password: 'integration-test-password' };
export const AGENT_KEY = 'ag_integration_test_key_0123456789abcdef';
export const APPROVAL_TIMEOUT_MS = 3000;

const urls = requireUrls();
export const adminDbUrl = urls.admin;
const classifier = loadClassifier(loadConfig({ DATABASE_URL: urls.app }).injectionModelPath);

export interface Harness {
  ctx: AppContext;
  app: ReturnType<typeof createApp>;
  adminDb: Db;
  /** Admin session cookie header value. */
  cookie: string;
  close(): Promise<void>;
}

export interface HarnessOptions {
  policy?: PolicyClient;
  noClassifier?: boolean;
  realtime?: boolean;
  config?: Partial<Config>;
}

/** Fresh data (schema already migrated by globalSetup), seeded identities, logged-in admin. */
export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  await truncateAll(adminDbUrl);
  const config: Config = {
    ...loadConfig({
      DATABASE_URL: urls.app,
      DATABASE_ADMIN_URL: urls.admin,
      OPA_URL: opaUrl,
      LOG_LEVEL: 'silent',
      BUSINESS_TIMEZONE: 'UTC',
      INTERNAL_EMAIL_DOMAINS: 'acme.example',
    }),
    approvalTimeoutMs: APPROVAL_TIMEOUT_MS,
    approvalPollIntervalMs: 100,
    // Business hours cover the whole day so wall-clock time never changes test outcomes.
    businessHours: { start: 0, end: 24, timeZone: 'UTC' },
    ...opts.config,
  };
  const logger = createLogger('silent');
  const db = createPool(urls.app, 20);
  const adminDb = createPool(urls.admin, 4);
  const ctx: AppContext = {
    config,
    db,
    logger,
    classifier: opts.noClassifier ? null : classifier,
    classifierError: opts.noClassifier ? 'disabled for test' : null,
    policy: opts.policy ?? createOpaPolicyClient({ opaUrl, timeoutMs: 2000, logger }),
    changeFeed: opts.realtime ? createChangeFeed(urls.app, logger) : null,
  };
  // Identities are provisioned with the owner role (the app role cannot insert agents/admins).
  await seedIdentities({ ...ctx, db: adminDb }, { adminUsername: ADMIN.username, adminPassword: ADMIN.password, demoAgentApiKey: AGENT_KEY, history: false });
  const app = createApp(ctx);
  const login = await request(app).post('/api/auth/login').send(ADMIN).expect(200);
  const cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  return {
    ctx,
    app,
    adminDb,
    cookie,
    async close() {
      await ctx.changeFeed?.close();
      await db.end();
      await adminDb.end();
    },
  };
}

export async function listen(app: ReturnType<typeof createApp>): Promise<{ url: string; server: Server }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

export const agentAuth = { authorization: `Bearer ${AGENT_KEY}` };
export const csrf = { 'x-agentguard-csrf': '1' };

export function submit(h: Harness, body: Record<string, unknown>) {
  return request(h.app).post('/api/tool-call').set(agentAuth).send(body);
}

export async function auditEvents(h: Harness, callId: string): Promise<string[]> {
  const r = await h.adminDb.query<{ event_type: string }>('SELECT event_type FROM audit_log WHERE referenced_call_id = $1 ORDER BY seq', [callId]);
  return r.rows.map((x) => x.event_type);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
