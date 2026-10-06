#!/usr/bin/env node
// Performance check required by the spec: a burst of 20-30 concurrent agent calls through
// the real HTTP API.   npm run demo:burst            (25 calls)
//                      npm run demo:burst -- 30
// Watch /activity while it runs to confirm the live feed keeps up.
import { loadEnv } from './lib/env.mjs';

loadEnv();
const n = Math.min(30, Math.max(20, Number(process.argv[2] ?? 25)));
const api = (process.env.API_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');
const key = process.env.DEMO_AGENT_API_KEY;
if (!key) {
  console.error('DEMO_AGENT_API_KEY is not set.');
  process.exit(1);
}

const started = performance.now();
const results = await Promise.all(
  Array.from({ length: n }, async (_, i) => {
    const t0 = performance.now();
    try {
      const res = await fetch(`${api}/api/tool-call`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          tool_name: i % 2 ? 'send_email' : 'run_db_query',
          params: i % 2 ? { to: 'ops@acme.example', subject: `Burst ${i}`, body: `Burst message ${i}` } : { query: `SELECT id FROM orders LIMIT ${i + 1}` },
        }),
      });
      const body = await res.json();
      return { ok: res.status === 200 || res.status === 202, decision: body.decision ?? body.error?.code, ms: performance.now() - t0 };
    } catch (err) {
      return { ok: false, decision: err.message, ms: performance.now() - t0 };
    }
  }),
);
const lat = results.map((r) => r.ms).sort((a, b) => a - b);
const by = results.reduce((acc, r) => ({ ...acc, [r.decision]: (acc[r.decision] ?? 0) + 1 }), {});
console.log(`burst of ${n} calls in ${(performance.now() - started).toFixed(0)} ms`);
console.log(`  succeeded: ${results.filter((r) => r.ok).length}   failed: ${results.filter((r) => !r.ok).length}`);
console.log(`  latency  avg ${(lat.reduce((a, b) => a + b, 0) / n).toFixed(0)} ms · p50 ${lat[Math.floor(n / 2)].toFixed(0)} ms · max ${lat.at(-1).toFixed(0)} ms`);
console.log('  outcomes', by);
process.exit(results.every((r) => r.ok) ? 0 : 1);
