// npm run demo:tamper                       -> flips the decision in the latest decision_made audit row
// npm run demo:tamper -- --mode hash|prev_hash|delete [--seq N]
// npm run demo:tamper -- --restore         -> puts the original row back; chain verifies again
import { resolve } from 'node:path';
import { repoRoot } from '../config.js';
import type { TamperMode } from '../devtools/tamper.js';
import { restore, tamper } from '../devtools/tamper.js';
import { adminUrl, fail } from './common.js';

const BACKUP = process.env.TAMPER_BACKUP_FILE ?? resolve(repoRoot, '.data', 'tamper-backup.json');
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

try {
  if (args.includes('--restore')) {
    const r = await restore(adminUrl(), BACKUP);
    console.log(`restored audit row #${r.seq} (${r.mode} tamper undone). Re-run "Verify integrity": it should PASS.`);
  } else {
    const mode = (flag('--mode') ?? 'payload') as TamperMode;
    if (!['payload', 'hash', 'prev_hash', 'delete'].includes(mode)) fail(`unknown --mode ${mode}`);
    const seqArg = flag('--seq');
    const r = await tamper(adminUrl(), BACKUP, mode, seqArg ? Number(seqArg) : undefined);
    console.log(`TAMPERED audit row #${r.seq} (${r.event_type}): ${r.description}.`);
    console.log('Now click "Verify integrity" on /audit-log (or run `npm run audit:verify`): it must FAIL at this row.');
    console.log('Undo with: npm run demo:tamper -- --restore');
  }
} catch (err) {
  fail(err);
}
