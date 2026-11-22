// Standalone audit-chain verifier (Implementation Plan §3.6): walks the whole chain with
// the application's read-only role and exits non-zero if any row was altered.
import { createPool } from '../db/pool.js';
import { verifyAuditLog } from '../audit/auditLog.js';
import { config, fail } from './common.js';
import { loadAuditAnchors } from '../audit/anchors.js';

const anchorsIndex = process.argv.indexOf('--anchors');
if (anchorsIndex !== -1 && !process.argv[anchorsIndex + 1]) fail(new Error('--anchors requires a file path or URL.'));
const db = createPool(config().databaseUrl, 1);
try {
  const anchors = anchorsIndex === -1 ? [] : await loadAuditAnchors(process.argv[anchorsIndex + 1]!);
  const r = await verifyAuditLog(db, anchors);
  console.log(JSON.stringify(r, null, 2));
  console.log(r.valid ? `PASS — ${r.message}` : `FAIL — ${r.message}`);
  process.exitCode = r.valid ? 0 : 2;
} catch (err) {
  fail(err);
} finally {
  await db.end();
}
