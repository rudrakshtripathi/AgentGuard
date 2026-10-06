import { createPool } from '../db/pool.js';
import { createLogger } from '../logger.js';
import { createOpaPolicyClient } from '../policy/policyClient.js';
import { loadClassifier } from '../scoring/injectionClassifier.js';
import { verifyAuditLog } from '../audit/auditLog.js';
import type { AppContext } from '../context.js';
import { seedHistory, seedIdentities } from '../devtools/seed.js';
import { adminUrl, config, fail } from './common.js';

export async function runSeed({ forceHistory = false } = {}) {
  const cfg = config();
  const username = process.env.ADMIN_USERNAME;
  const password = process.env.ADMIN_PASSWORD;
  const agentKey = process.env.DEMO_AGENT_API_KEY;
  if (!username || !password || !agentKey) {
    fail('ADMIN_USERNAME, ADMIN_PASSWORD and DEMO_AGENT_API_KEY must be set (see .env.example).');
  }
  const db = createPool(adminUrl(), 4);
  const logger = createLogger('warn');
  const ctx: AppContext = {
    config: cfg,
    db,
    logger,
    classifier: loadClassifier(cfg.injectionModelPath),
    classifierError: null,
    policy: createOpaPolicyClient({ opaUrl: cfg.opaUrl, timeoutMs: cfg.opaTimeoutMs, logger }),
    changeFeed: null,
  };
  try {
    const ids = await seedIdentities(ctx, { adminUsername: username, adminPassword: password, demoAgentApiKey: agentKey, history: true });
    console.log(`admin "${ids.admin.username}" and agents [${Object.keys(ids.agents).join(', ')}] provisioned`);

    const existing = await db.query<{ calls: number; audit: number }>(
      'SELECT (SELECT count(*) FROM tool_calls)::int AS calls, (SELECT count(*) FROM audit_log)::int AS audit',
    );
    const { calls, audit } = existing.rows[0]!;
    if ((calls > 0 || audit > 0) && !forceHistory) {
      console.log(`historical data skipped: database already has ${calls} calls / ${audit} audit rows (use \`npm run db:reset -- --yes\` for a fresh demo dataset)`);
    } else {
      if (!(await ctx.policy.health())) {
        fail(`OPA is not reachable at ${cfg.opaUrl} (or the policy is not loaded). Start it with \`npm run opa:start\`: seeded decisions must come from OPA.`);
      }
      const result = await seedHistory(ctx, ids);
      console.log(`seeded ${result.calls} historical calls through the real pipeline:`, result.tally);
    }
    const verify = await verifyAuditLog(db);
    console.log(`audit chain: ${verify.message}`);
    if (!verify.valid) process.exitCode = 1;
  } finally {
    await db.end();
  }
}
