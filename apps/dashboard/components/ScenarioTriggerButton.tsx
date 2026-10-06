'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import type { CallStatus, ScenarioInfo, ScenarioResult } from '@/lib/types';
import { StatusBadge } from './StatusBadge';
import { Button } from './ui';
import { PlayIcon } from './icons';

const toStatus = (d: 'allow' | 'block' | 'pending'): CallStatus => (d === 'allow' ? 'allowed' : d === 'block' ? 'blocked' : 'pending');

/**
 * One canned scenario. Runs the REAL pipeline via POST /api/demo/trigger/:scenario and
 * shows the actual outcome returned by the system inline (spec §5 S-07).
 */
export function ScenarioTriggerButton({ scenario }: { scenario: ScenarioInfo }) {
  const [state, setState] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<ScenarioResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(false), 1200);
    return () => clearTimeout(t);
  }, [flash]);

  async function trigger() {
    setState('running');
    setError(null);
    try {
      const r = await api<ScenarioResult>(`/api/demo/trigger/${scenario.name}`, { method: 'POST' });
      setResult(r);
      setState('done');
      setFlash(true);
    } catch (e) {
      setError((e as ApiError).message);
      setState('error');
    }
  }

  const single = result && result.results.length === 1 ? result.results[0]! : null;
  return (
    <article
      data-scenario={scenario.name}
      className={`flex flex-col rounded-md border bg-surface p-5 shadow-[var(--shadow-1)] transition-colors duration-200 ${flash ? 'border-primary' : 'border-border'}`}
    >
      <h2 className="type-h3">{scenario.title}</h2>
      <p className="mt-1 text-muted">{scenario.description}</p>
      <p className="type-caption mt-2">Expected: {scenario.expected}</p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button onClick={trigger} loading={state === 'running'} aria-label={`Trigger ${scenario.title}`}>
          <PlayIcon />
          Trigger
        </Button>
        {state === 'error' && (
          <Button variant="secondary" onClick={trigger}>
            Retry
          </Button>
        )}
      </div>
      <div className="mt-4 min-h-12" aria-live="polite">
        {state === 'error' && <p className="text-error">Couldn&apos;t run this scenario: {error}</p>}
        {state === 'done' && single && (
          <div className="space-y-2" data-result-decision={single.decision}>
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge status={toStatus(single.decision)} />
              <span className="type-data">risk {single.risk.final_score.toFixed(1)}</span>
              <span className="type-caption">{single.policy_name}</span>
            </div>
            <p className="type-caption">
              {single.execution ? (single.execution.executed ? 'Mock tool executed (sandboxed).' : 'Mock tool NOT executed.') : 'Waiting for a human on Approvals.'}
            </p>
            <div className="flex gap-4">
              <Link href={`/calls/${single.call_id}?from=activity`} className="text-primary hover:underline">
                View call
              </Link>
              {single.decision === 'pending' && (
                <Link href="/approvals" className="text-primary hover:underline">
                  Go to Approvals
                </Link>
              )}
              <Link href="/activity" className="text-primary hover:underline">
                View in Activity
              </Link>
            </div>
          </div>
        )}
        {state === 'done' && result && !single && (
          <div className="space-y-1" data-result-total={result.summary.total}>
            <p className="type-data">
              {result.summary.total} calls · {result.summary.allow} allowed · {result.summary.pending} pending · {result.summary.block} blocked · {result.summary.failed} failed
            </p>
            <p className="type-caption">
              avg {result.summary.avg_latency_ms} ms · max {result.summary.max_latency_ms} ms per decision
            </p>
            <Link href="/activity" className="text-primary hover:underline">
              View in Activity
            </Link>
          </div>
        )}
      </div>
    </article>
  );
}
