'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ApiError, api } from '@/lib/api';
import { useLiveData } from '@/lib/live';
import { formatDateTime } from '@/lib/format';
import type { CallDetail, CallStatus } from '@/lib/types';
import { HashValue } from '@/components/HashValue';
import { RiskMeter } from '@/components/RiskMeter';
import { StatusBadge } from '@/components/StatusBadge';
import { Alert, Card, EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui';
import { ArrowLeftIcon, SpinnerIcon } from '@/components/icons';

const BACK: Record<string, { href: string; label: string }> = {
  approvals: { href: '/approvals', label: 'Back to Approvals' },
  'audit-log': { href: '/audit-log', label: 'Back to Audit Log' },
  activity: { href: '/activity', label: 'Back to Activity' },
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="type-label mb-0.5">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Detail() {
  const { id } = useParams<{ id: string }>();
  const from = useSearchParams().get('from') ?? 'activity';
  const back = BACK[from] ?? BACK.activity!;
  const { data, error, loading, refresh } = useLiveData(() => api<CallDetail>(`/api/tool-calls/${id}`), id);

  const backLink = (
    <Link href={back.href} className="inline-flex items-center gap-1 text-primary hover:underline">
      <ArrowLeftIcon /> {back.label}
    </Link>
  );

  if (error && (error as ApiError).status === 404) {
    return (
      <>
        <PageHeader title="Call not found" />
        <EmptyState>No call exists with id {id}. {backLink}</EmptyState>
      </>
    );
  }
  if (error && (error as ApiError).status === 400) {
    return (
      <>
        <PageHeader title="Call not found" />
        <EmptyState>That is not a valid call id. {backLink}</EmptyState>
      </>
    );
  }
  if (loading && !data) {
    return (
      <>
        <Skeleton className="mb-6 h-9 w-80" />
        <div className="grid gap-6 desktop:grid-cols-2">
          <Skeleton className="h-80" />
          <Skeleton className="h-80" />
        </div>
      </>
    );
  }
  if (!data) return error ? <ErrorState error={error} onRetry={refresh} /> : null;

  const b = data.risk?.breakdown ?? null;
  return (
    <>
      <div className="mb-3">{backLink}</div>
      <PageHeader title={`Call ${data.id.slice(0, 8)}`}>
        <StatusBadge status={data.status as CallStatus} />
        <span className="type-data text-muted" title={data.id}>
          {data.id}
        </span>
      </PageHeader>
      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={refresh} />
        </div>
      )}

      {data.pipeline_state === 'in_progress' && (
        <div className="mb-6">
          <Alert tone="info" title="In progress" live="polite">
            <span className="inline-flex items-center gap-2">
              <SpinnerIcon /> This call is still being scored or decided. Results appear here automatically — nothing below is final yet.
            </span>
          </Alert>
        </div>
      )}
      {data.pipeline_state === 'awaiting_approval' && data.approval && (
        <div className="mb-6">
          <Alert tone="warning" title="Awaiting human approval">
            Not executed. Auto-denies at {formatDateTime(data.approval.expires_at)} if nobody decides.{' '}
            <Link href="/approvals" className="text-primary hover:underline">
              Open Approvals
            </Link>
          </Alert>
        </div>
      )}

      <div className="grid gap-6 desktop:grid-cols-2">
        <Card className="p-5">
          <h2 className="type-h2 mb-4">Request</h2>
          <dl className="grid grid-cols-2 gap-4">
            <Field label="Tool">
              <span className="type-data">{data.tool_name}</span>
            </Field>
            <Field label="Agent">{data.agent_name}</Field>
            <Field label="Requested">
              <span className="type-data">{formatDateTime(data.requested_at)}</span>
            </Field>
            <Field label="Execution">
              {data.execution ? (
                <span className={data.execution.executed ? 'text-success' : 'text-error'} data-executed={data.execution.executed}>
                  {data.execution.executed ? 'Executed (sandboxed mock)' : 'Not executed'}
                </span>
              ) : (
                <span className="text-muted">Not executed yet</span>
              )}
            </Field>
          </dl>
          <h3 className="type-label mb-1 mt-5">Raw payload</h3>
          {/* Agent-supplied content: rendered as plain text only, never as HTML. */}
          <pre className="type-data max-h-80 overflow-auto rounded-sm border border-border bg-bg p-3 whitespace-pre-wrap break-words" data-testid="raw-payload">
            {JSON.stringify(data.params, null, 2)}
          </pre>
          {data.execution && (
            <>
              <h3 className="type-label mb-1 mt-5">Execution result</h3>
              <pre className="type-data max-h-48 overflow-auto rounded-sm border border-border bg-bg p-3 whitespace-pre-wrap break-words">
                {JSON.stringify(data.execution.executed ? data.execution.result : { reason: data.execution.reason }, null, 2)}
              </pre>
            </>
          )}
        </Card>

        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="type-h2 mb-4">Risk score</h2>
            {data.risk ? (
              <>
                <RiskMeter
                  variant="expanded"
                  final={data.risk.final_score}
                  rule={data.risk.rule_score}
                  injection={data.risk.injection_score}
                  injectionNote={b?.injection.status === 'scored' ? undefined : b?.injection.status === 'skipped' ? 'skipped: no free text' : 'classifier unavailable'}
                />
                {b && (
                  <>
                    <p className="type-caption mt-3">Combination: {b.combination}</p>
                    <h3 className="type-label mb-1 mt-4">Rule checklist</h3>
                    <table className="w-full text-left">
                      <tbody>
                        {b.rules.factors.map((f) => (
                          <tr key={f.id} className="border-t border-border/60">
                            <td className="py-1 pr-3">{f.label}</td>
                            <td className="type-data py-1 text-right">+{f.points}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="type-caption mt-2">{b.injection.detail}</p>
                    {b.evaluated_at_simulated && (
                      <p className="type-caption mt-1 text-warning">
                        Timing evaluated at a simulated time ({formatDateTime(b.evaluated_at)}) — scripted by the demo scenario.
                      </p>
                    )}
                  </>
                )}
              </>
            ) : (
              <p className="text-muted">Not scored yet.</p>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="type-h2 mb-4">Policy decision (OPA)</h2>
            {data.policy ? (
              <dl className="space-y-3">
                <Field label="Decision">
                  <span className="type-data">{data.policy.decision}</span>
                  {data.policy.source === 'fail_closed' && <span className="ml-2 text-error">(fail-closed: OPA could not decide)</span>}
                </Field>
                <Field label="Policy rule(s) fired">
                  <span className="type-data" title="Rego rule names in policies/agentguard.rego">
                    {data.policy.policy_name}
                  </span>
                </Field>
                <Field label="Reasoning">
                  <ul className="list-disc space-y-0.5 pl-5">
                    {data.policy.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </Field>
              </dl>
            ) : (
              <p className="text-muted">No decision yet.</p>
            )}
          </Card>

          {data.approval && (
            <Card className="p-5">
              <h2 className="type-h2 mb-4">Human approval</h2>
              <dl className="grid grid-cols-2 gap-4">
                <Field label="Status">
                  <StatusBadge status={data.approval.status as CallStatus} />
                </Field>
                <Field label="Reviewer">{data.approval.reviewer_username ?? (data.approval.status === 'timeout_denied' ? 'none (timed out)' : '—')}</Field>
                <Field label="Requested">
                  <span className="type-data">{formatDateTime(data.approval.created_at)}</span>
                </Field>
                <Field label="Resolved">
                  <span className="type-data">{data.approval.resolved_at ? formatDateTime(data.approval.resolved_at) : '—'}</span>
                </Field>
              </dl>
            </Card>
          )}
        </div>
      </div>

      <Card className="mt-6 p-5">
        <h2 className="type-h2 mb-1">Audit trail</h2>
        <p className="type-caption mb-3">Hash-chained entries for this call (verify the whole chain on the Audit Log page).</p>
        <ol className="space-y-1">
          {data.audit_events.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-x-4 border-t border-border/60 py-1.5">
              <span className="type-data w-12 text-muted">#{e.seq}</span>
              <span className="type-data w-44">{e.event_type}</span>
              <span className="type-data text-muted">{formatDateTime(e.created_at)}</span>
              <span className="ml-auto">
                <HashValue value={e.hash} label={`Hash of row ${e.seq}`} />
              </span>
            </li>
          ))}
        </ol>
      </Card>
    </>
  );
}

export default function CallDetailPage() {
  return (
    <Suspense>
      <Detail />
    </Suspense>
  );
}
