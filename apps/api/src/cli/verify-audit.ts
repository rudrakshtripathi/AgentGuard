// Standalone audit-chain verifier (Implementation Plan §3.6): walks the whole chain with
// the application's read-only role and exits non-zero if any row was altered.
import { createPool } from '../db/pool.js';
import { verifyAuditLog } from '../audit/auditLog.js';
import { config, fail } from './common.js';

const db = createPool(config().databaseUrl, 1);
try {
  const r = await verifyAuditLog(db);
  console.log(JSON.stringify(r, null, 2));
  console.log(r.valid ? `PASS — ${r.message}` : `FAIL — ${r.message}`);
  process.exitCode = r.valid ? 0 : 2;
} catch (err) {
  fail(err);
} finally {
  await db.end();
}
