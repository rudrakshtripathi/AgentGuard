import { describe, expect, it } from 'vitest';
import type { RuleContext } from '../../src/scoring/ruleScorer.js';
import { isOffHours, localHour, scoreRules } from '../../src/scoring/ruleScorer.js';
import { CLASSIFIER_UNAVAILABLE_FLOOR, assessRisk, combineScores } from '../../src/scoring/riskScoring.js';

// 11:00 UTC on a weekday — inside business hours.
const ctx: RuleContext = {
  evaluatedAt: new Date('2026-03-04T11:00:00Z'),
  businessHours: { start: 7, end: 21, timeZone: 'UTC' },
  internalEmailDomains: ['acme.example'],
  recentCallCount: 0,
};
const ids = (r: ReturnType<typeof scoreRules>) => r.factors.map((f) => f.id);

describe('rule scorer (weighted checklist)', () => {
  const routine = scoreRules('send_email', { to: 'maria@acme.example', subject: 's', body: 'hello' }, ctx);
  const bulkDelete = scoreRules('delete_file', { path: '/srv/reports/2025/*', recursive: true }, ctx);

  it('scores a routine internal email low', () => {
    expect(routine.rule_score).toBe(10);
    expect(routine.category).toBe('communication');
    expect(ids(routine)).toEqual(['action_type']);
  });

  it('scores a bulk delete visibly higher than a routine call (Phase 2 done-criterion)', () => {
    expect(bulkDelete.rule_score).toBe(60);
    expect(bulkDelete.rule_score).toBeGreaterThan(routine.rule_score);
    expect(ids(bulkDelete)).toEqual(['action_type', 'bulk_scope']);
  });

  it('adds sensitive target points for system/secret paths', () => {
    const r = scoreRules('delete_file', { path: '/etc/passwd' }, ctx);
    expect(ids(r)).toContain('sensitive_target');
    expect(r.rule_score).toBe(55);
  });

  it('flags external and bulk email recipients', () => {
    const many = Array.from({ length: 12 }, (_, i) => `u${i}@other.example`);
    const r = scoreRules('send_email', { to: many, body: 'x' }, ctx);
    expect(ids(r)).toEqual(expect.arrayContaining(['external_recipient', 'bulk_recipients']));
    expect(r.rule_score).toBe(40);
  });

  it('scales payment risk with amount and penalises invalid amounts', () => {
    expect(scoreRules('process_payment', { recipient: 'A', amount: 200 }, ctx).rule_score).toBe(30);
    expect(scoreRules('process_payment', { recipient: 'A', amount: 4800 }, ctx).rule_score).toBe(40);
    expect(scoreRules('process_payment', { recipient: 'A', amount: 25_000 }, ctx).rule_score).toBe(55);
    expect(ids(scoreRules('process_payment', { recipient: 'A', amount: -5 }, ctx))).toContain('invalid_amount');
    expect(ids(scoreRules('process_payment', { recipient: 'A', amount: '100' }, ctx))).toContain('invalid_amount');
  });

  it('treats destructive SQL as destructive and unbounded mutations as bulk', () => {
    const drop = scoreRules('run_db_query', { query: 'DELETE FROM users' }, ctx);
    expect(drop.category).toBe('destructive');
    expect(ids(drop)).toEqual(['action_type', 'destructive_query', 'unbounded_mutation', 'sensitive_target']);
    expect(drop.rule_score).toBe(75);
    const ddl = scoreRules('run_db_query', { query: 'DROP TABLE users' }, ctx);
    expect(ids(ddl)).toEqual(['action_type', 'destructive_query', 'irreversible_ddl', 'sensitive_target']);
    expect(ddl.rule_score).toBeGreaterThanOrEqual(70); // lands in the block band
    const read = scoreRules('run_db_query', { query: 'SELECT id FROM projects LIMIT 5' }, ctx);
    expect(read.rule_score).toBe(10);
  });

  it('scores unknown tools conservatively, never as zero', () => {
    const r = scoreRules('launch_rockets', { target: 'moon' }, ctx);
    expect(r.known_tool).toBe(false);
    expect(r.category).toBe('unknown');
    expect(r.rule_score).toBe(40);
  });

  it('scores a missing target as uncertainty', () => {
    expect(ids(scoreRules('delete_file', {}, ctx))).toContain('target_missing');
    expect(scoreRules('send_email', { body: 'hi' }, ctx).rule_score).toBeGreaterThan(routine.rule_score);
  });

  it('adds timing risk outside business hours, more for financial actions', () => {
    const night = { ...ctx, evaluatedAt: new Date('2026-03-04T03:14:00Z') };
    expect(scoreRules('send_email', { to: 'a@acme.example' }, night).rule_score).toBe(20);
    const pay = scoreRules('process_payment', { recipient: 'Northwind', amount: 4800 }, night);
    expect(ids(pay)).toContain('off_hours_sensitive_action');
    expect(pay.rule_score).toBe(60);
    expect(pay.off_hours).toBe(true);
    expect(pay.local_hour).toBe(3);
  });

  it('adds frequency risk for bursts', () => {
    expect(scoreRules('send_email', { to: 'a@acme.example' }, { ...ctx, recentCallCount: 15 }).rule_score).toBe(20);
    expect(scoreRules('send_email', { to: 'a@acme.example' }, { ...ctx, recentCallCount: 30 }).rule_score).toBe(30);
  });

  it('caps at 100', () => {
    const r = scoreRules('delete_file', { paths: ['/', '/etc/*'], recursive: true }, { ...ctx, recentCallCount: 40, evaluatedAt: new Date('2026-03-04T02:00:00Z') });
    expect(r.rule_score).toBe(100);
  });

  it('computes local hours in the configured timezone', () => {
    const at = new Date('2026-03-04T22:30:00Z');
    expect(localHour(at, 'UTC')).toBe(22);
    expect(localHour(at, 'Asia/Kolkata')).toBe(4);
    expect(isOffHours(at, { start: 7, end: 21, timeZone: 'UTC' })).toBe(true);
    expect(isOffHours(new Date('2026-03-04T08:00:00Z'), { start: 7, end: 21, timeZone: 'UTC' })).toBe(false);
  });
});

describe('score combination', () => {
  it('uses max(rule, injection) when the classifier scored the text', () => {
    expect(combineScores(20, { injection_score: 90.5, status: 'scored', detail: '' }).final).toBe(90.5);
    expect(combineScores(60, { injection_score: 5, status: 'scored', detail: '' }).final).toBe(60);
  });
  it('uses the rule score alone when classification was skipped', () => {
    expect(combineScores(35, { injection_score: null, status: 'skipped', detail: '' }).final).toBe(35);
  });
  it('fails toward caution when the classifier is unavailable', () => {
    expect(combineScores(10, { injection_score: null, status: 'unavailable', detail: '' }).final).toBe(CLASSIFIER_UNAVAILABLE_FLOOR);
    expect(combineScores(80, { injection_score: null, status: 'unavailable', detail: '' }).final).toBe(80);
  });
  it('assessRisk keeps injection_score null (not 0) when there is no text and when the model is missing', () => {
    const skipped = assessRisk(null, 'process_payment', { amount: 5 }, ctx);
    expect(skipped.injection_score).toBeNull();
    expect(skipped.breakdown.injection.status).toBe('skipped');
    const missing = assessRisk(null, 'send_email', { to: 'a@acme.example', body: 'hello there' }, ctx);
    expect(missing.injection_score).toBeNull();
    expect(missing.breakdown.injection.status).toBe('unavailable');
    expect(missing.final_score).toBe(CLASSIFIER_UNAVAILABLE_FLOOR);
  });
});
