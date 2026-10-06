import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createLogger, errorFields } from './logger.js';
import { createOpaPolicyClient } from './policy/policyClient.js';
import { loadClassifier } from './scoring/injectionClassifier.js';
import type { InjectionClassifier } from './scoring/injectionClassifier.js';
import { createChangeFeed } from './realtime/changeFeed.js';
import { startApprovalSweeper } from './approvals/approvals.js';
import type { AppContext } from './context.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);

let classifier: InjectionClassifier | null = null;
let classifierError: string | null = null;
try {
  classifier = loadClassifier(config.injectionModelPath);
  logger.info('injection classifier loaded', { features: classifier.featureCount });
} catch (err) {
  // Not fatal: scoring fails toward caution (final >= 50 -> human review) and /health reports it.
  classifierError = (err as Error).message;
  logger.error('injection classifier unavailable', { error: classifierError });
}

const db = createPool(config.databaseUrl);
try {
  await db.query('SELECT 1 FROM audit_log LIMIT 1');
} catch (err) {
  logger.error('database unreachable or not migrated — run `npm run db:migrate`', errorFields(err));
  process.exit(1);
}

const ctx: AppContext = {
  config,
  db,
  logger,
  classifier,
  classifierError,
  policy: createOpaPolicyClient({ opaUrl: config.opaUrl, timeoutMs: config.opaTimeoutMs, logger }),
  changeFeed: createChangeFeed(config.databaseUrl, logger),
};

if (!(await ctx.policy.health())) {
  logger.warn('OPA is not reachable or the agentguard policy is not loaded — every call will FAIL CLOSED (block) until it is', {
    opa_url: config.opaUrl,
  });
}

const stopSweeper = startApprovalSweeper(ctx);
const server = createApp(ctx).listen(config.apiPort, config.apiHost, () => {
  logger.info('AgentGuard API listening', { url: `http://${config.apiHost}:${config.apiPort}`, opa_url: config.opaUrl });
});

async function shutdown(signal: string) {
  logger.info('shutting down', { signal });
  stopSweeper();
  server.close();
  server.closeAllConnections();
  await ctx.changeFeed?.close();
  await db.end().catch(() => {});
  process.exit(0);
}
for (const s of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(s, () => void shutdown(s));
