import { dropAll } from '../db/reset.js';
import { migrate } from '../db/migrate.js';
import { adminUrl, config, fail } from './common.js';
import { runSeed } from './seedRunner.js';

if (!process.argv.includes('--yes')) {
  console.error('This DROPS all AgentGuard tables (including the audit log) and re-seeds. Re-run with: npm run db:reset -- --yes');
  process.exit(1);
}
const cfg = config();
try {
  await dropAll(adminUrl());
  const result = await migrate(adminUrl(), cfg.databaseUrl);
  console.log(`schema recreated (${result.applied.length} migrations)`);
  await runSeed({ forceHistory: true });
} catch (err) {
  fail(err);
}
