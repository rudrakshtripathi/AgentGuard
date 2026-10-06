'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { describeTarget, formatDateTime } from '@/lib/format';
import type { PendingApproval } from '@/lib/types';
import { RiskMeter } from './RiskMeter';
import { Button } from './ui';
import { useToast } from './Toast';
import { ClockIcon } from './icons';

function useSecondsLeft(expiresAt: string) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.round((new Date(expiresAt).getTime() - now) / 1000));
}

/**
 * One pending approval with enough context to decide in seconds (US-003): action, target,
 * params, risk, policy reasons, requested time, and time left before default-deny.
 */
export function ApprovalCard({ item, onResolved }: { item: PendingApproval; onResolved: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const secondsLeft = useSecondsLeft(item.expires_at);

  async function decide(decision: 'approve' | 'reject') {
    setBusy(decision);
    setError(null);
    try {
      const r = await api<{ execution: { executed: boolean } }>(`/api/approvals/${item.approval_id}/decide`, { method: 'POST', body: { decision } });
      toast('success', decision === 'approve' ? `Approved — ${r.execution.executed ? 'the action was executed (sandboxed).' : 'no sandboxed implementation, nothing ran.'}` : 'Rejected — the action will not run.');
      onResolved();
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 409) {
        setConflict(err.message);
        onResolved();
      } else {
        setError(err.message);
        toast('error', `Couldn't ${decision} this action: ${err.message}`);
      }
    } finally {
      setBusy(null);
    }
  }

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = String(secondsLeft % 60).padStart(2, '0');
  return (
    <article
      aria-label={`Pending approval: ${item.tool_name}`}
      data-approval-id={item.approval_id}
      className={`rounded-md border border-border bg-surface p-5 shadow-[var(--shadow-1)] transition-opacity duration-200 ${busy ? 'opacity-70' : ''}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="type-h3">
            <span className="type-data">{item.tool_name}</span> <span className="text-muted">requested by</span> {item.agent_name}
          </h2>
          <p className="mt-1 break-words text-text">{describeTarget(item.tool_name, item.params)}</p>
        </div>
        <span className={`inline-flex items-center gap-1.5 text-xs ${secondsLeft < 30 ? 'text-warning' : 'text-muted'}`} aria-live="off">
          <ClockIcon className="h-3.5 w-3.5" />
          {secondsLeft > 0 ? `Auto-denies in ${minutes}:${seconds}` : 'Timing out — will be denied'}
        </span>
      </div>

      <dl className="mt-4 grid gap-4 tablet:grid-cols-2">
        <div>
          <dt className="type-label mb-1">Final risk</dt>
          <dd>
            <RiskMeter final={item.final_score} />
            <p className="type-caption mt-1">
              rule {item.rule_score ?? '—'} · injection {item.injection_score ?? 'n/a'}
            </p>
          </dd>
        </div>
        <div>
          <dt className="type-label mb-1">Requested</dt>
          <dd className="type-data">{formatDateTime(item.requested_at)}</dd>
        </div>
        <div className="tablet:col-span-2">
          <dt className="type-label mb-1">Why it needs review ({item.policy_name})</dt>
          <dd>
            <ul className="list-disc space-y-0.5 pl-5">
              {item.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </dd>
        </div>
        <div className="tablet:col-span-2">
          <dt className="type-label mb-1">Parameters</dt>
          <dd>
            <pre className="type-data max-h-40 overflow-auto rounded-sm border border-border bg-bg p-3 whitespace-pre-wrap break-words">{JSON.stringify(item.params, null, 2)}</pre>
          </dd>
        </div>
      </dl>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        {conflict ? (
          <p role="status" className="font-medium text-warning">
            {conflict}
          </p>
        ) : (
          <>
            <Button onClick={() => decide('approve')} loading={busy === 'approve'} disabled={busy !== null}>
              Approve
            </Button>
            <Button variant="destructive" onClick={() => decide('reject')} loading={busy === 'reject'} disabled={busy !== null}>
              Reject
            </Button>
          </>
        )}
        <Link href={`/calls/${item.id}?from=approvals`} className="ml-auto text-primary hover:underline">
          View full detail
        </Link>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-error">
          Couldn&apos;t resolve: {error} Try again.
        </p>
      )}
    </article>
  );
}
