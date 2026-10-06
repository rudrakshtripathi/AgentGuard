import type { InjectionClassifier, InjectionResult } from './injectionClassifier.js';
import { scoreInjection } from './injectionClassifier.js';
import type { RuleContext, RuleScoreResult } from './ruleScorer.js';
import { scoreRules } from './ruleScorer.js';

/**
 * Risk Scoring module (TRD §5). All scoring math lives here — never in Rego.
 *
 * Combination rule (resolves PRD Open Question #6):
 *   injection scored      -> final = max(rule_score, injection_score)
 *   injection skipped     -> final = rule_score            (no free text to classify)
 *   injection unavailable -> final = max(rule_score, 50)   (fail toward caution, FR-003)
 *
 * max() rather than a weighted average: the most severe independent signal dominates, so
 * a benign-looking action cannot dilute a strong injection signal (and vice versa).
 */
export const CLASSIFIER_UNAVAILABLE_FLOOR = 50;

export interface RiskAssessment {
  rule_score: number;
  injection_score: number | null;
  final_score: number;
  breakdown: {
    combination: string;
    rules: RuleScoreResult;
    injection: InjectionResult;
    evaluated_at: string;
    evaluated_at_simulated: boolean;
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function combineScores(ruleScore: number, injection: InjectionResult): { final: number; rule: string } {
  if (injection.status === 'scored' && injection.injection_score !== null) {
    return { final: round2(Math.max(ruleScore, injection.injection_score)), rule: 'max(rule_score, injection_score)' };
  }
  if (injection.status === 'unavailable') {
    return {
      final: round2(Math.max(ruleScore, CLASSIFIER_UNAVAILABLE_FLOOR)),
      rule: `max(rule_score, ${CLASSIFIER_UNAVAILABLE_FLOOR}) — classifier unavailable, failing toward caution`,
    };
  }
  return { final: round2(ruleScore), rule: 'rule_score (no free text to classify)' };
}

export function assessRisk(
  classifier: InjectionClassifier | null,
  toolName: string,
  params: Record<string, unknown>,
  ctx: RuleContext & { simulatedTime?: boolean },
): RiskAssessment {
  const rules = scoreRules(toolName, params, ctx);
  const injection = scoreInjection(classifier, params);
  const combined = combineScores(rules.rule_score, injection);
  return {
    rule_score: rules.rule_score,
    injection_score: injection.injection_score,
    final_score: combined.final,
    breakdown: {
      combination: combined.rule,
      rules,
      injection,
      evaluated_at: ctx.evaluatedAt.toISOString(),
      evaluated_at_simulated: Boolean(ctx.simulatedTime),
    },
  };
}
