import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { repoRoot, apiRoot } from '../config.js';
import { createLogger } from '../logger.js';
import { createOpaPolicyClient } from '../policy/policyClient.js';
import { buildPolicyInput } from '../policy/policyClient.js';
import { assessRisk } from '../scoring/riskScoring.js';
import { loadClassifier } from '../scoring/injectionClassifier.js';

interface EvalCase {
  id: string;
  tool: string;
  params: Record<string, unknown>;
  expected_decision: 'allow' | 'approve' | 'block';
  category: string;
  notes: string;
  known_failure?: { reason: string };
}

const cases = JSON.parse(await readFile(resolve(repoRoot, 'evals/cases.json'), 'utf8')) as EvalCase[];
const thresholds = JSON.parse(await readFile(resolve(repoRoot, 'evals/thresholds.json'), 'utf8')) as {
  min_decision_accuracy: number;
  min_attack_detection_rate: number;
  max_benign_false_positive_rate: number;
};
const logger = createLogger('silent');
const opaUrl = (process.env.OPA_URL ?? 'http://127.0.0.1:8181').replace(/\/$/, '');
const policy = createOpaPolicyClient({ opaUrl, timeoutMs: 2000, logger });
if (!(await policy.health())) throw new Error(`OPA policy is unavailable at ${opaUrl}; start OPA with policies/ loaded.`);
const classifier = loadClassifier(resolve(apiRoot, 'models/injection-model.json'));
const context = { businessHours: { start: 7, end: 21, timeZone: 'UTC' }, internalEmailDomains: ['acme.example'] };
const results: { id: string; category: string; expected: string; actual: string; known_failure?: string }[] = [];

for (const item of cases) {
  const { requested_at, ...params } = item.params;
  const risk = assessRisk(classifier, item.tool, params, {
    ...context,
    evaluatedAt: typeof requested_at === 'string' ? new Date(requested_at) : new Date('2026-01-01T11:14:00Z'),
    recentCallCount: 0,
  });
  const result = await policy.evaluate(buildPolicyInput({
    toolName: item.tool, params, risk, agentName: 'eval-agent', recentCallCount: 0, duplicatePendingCallId: null,
  }));
  results.push({ id: item.id, category: item.category, expected: item.expected_decision, actual: result.decision,
    ...(item.known_failure ? { known_failure: item.known_failure.reason } : {}) });
}

const matrix: Record<string, Record<string, number>> = { allow: { allow: 0, approve: 0, block: 0 }, approve: { allow: 0, approve: 0, block: 0 }, block: { allow: 0, approve: 0, block: 0 } };
for (let i = 0; i < cases.length; i++) matrix[cases[i]!.expected_decision]![results[i]!.actual]!++;
const matches = results.filter((r) => r.expected === r.actual).length;
const attackCases = results.filter((r) => !r.category.endsWith('_benign'));
const detectedAttacks = attackCases.filter((r) => r.actual !== 'allow').length;
const benignCases = results.filter((r) => r.category.endsWith('_benign'));
const falsePositives = benignCases.filter((r) => r.actual !== r.expected).length;
const accuracy = matches / cases.length;
const detection = attackCases.length ? detectedAttacks / attackCases.length : 1;
const falsePositiveRate = benignCases.length ? falsePositives / benignCases.length : 0;
const byCategory = Object.fromEntries([...new Set(results.map((r) => r.category))].map((category) => {
  const group = results.filter((r) => r.category === category);
  const attacks = category.endsWith('_benign') ? [] : group;
  const benign = category.endsWith('_benign') ? group : [];
  return [category, {
    cases: group.length,
    decision_accuracy: group.filter((r) => r.expected === r.actual).length / group.length,
    ...(attacks.length ? { detection_rate: attacks.filter((r) => r.actual !== 'allow').length / attacks.length } : {}),
    ...(benign.length ? { false_positive_rate: benign.filter((r) => r.actual !== r.expected).length / benign.length } : {}),
  }];
}));
const mismatches = results.filter((r) => r.expected !== r.actual);
const report = {
  generated_at: new Date().toISOString(), cases: cases.length,
  metrics: { decision_accuracy: accuracy, attack_detection_rate: detection, benign_false_positive_rate: falsePositiveRate },
  confusion_matrix: matrix, by_category: byCategory, mismatches, thresholds, results,
};
await mkdir(resolve(repoRoot, '.data'), { recursive: true });
await writeFile(resolve(repoRoot, '.data/eval-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Evaluation cases: ${cases.length}`);
console.log('Confusion matrix (rows=expected, columns=actual):');
console.table(matrix);
console.log('Per-category rates:');
console.table(byCategory);
console.log(`Decision accuracy ${(accuracy * 100).toFixed(1)}%; attack detection ${(detection * 100).toFixed(1)}%; benign false positives ${(falsePositiveRate * 100).toFixed(1)}%`);
if (mismatches.length) console.log('Mismatches:', JSON.stringify(mismatches, null, 2));
console.log('Report written to .data/eval-report.json');
if (accuracy < thresholds.min_decision_accuracy || detection < thresholds.min_attack_detection_rate || falsePositiveRate > thresholds.max_benign_false_positive_rate) {
  console.error('Evaluation thresholds were not met.');
  process.exitCode = 1;
}
