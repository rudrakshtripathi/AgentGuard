import { migrate } from '../db/migrate.js';
import { adminUrl, config, fail } from './common.js';

const cfg = config();
try {
  const result = await migrate(adminUrl(), cfg.databaseUrl);
  console.log(result.applied.length ? `applied: ${result.applied.join(', ')}` : 'schema up to date');
  if (result.appRole?.privileged) {
    console.warn(
      `WARNING: DATABASE_URL uses the owner role "${result.appRole.name}". The append-only audit_log trigger still applies, ` +
        'but use a separate application role in DATABASE_URL to also get DB-level REVOKE UPDATE/DELETE (see README).',
    );
  } else if (result.appRole) {
    console.log(`application role "${result.appRole.name}" provisioned (least privilege; no UPDATE/DELETE on audit_log)`);
  }
} catch (err) {
  fail(err);
}
