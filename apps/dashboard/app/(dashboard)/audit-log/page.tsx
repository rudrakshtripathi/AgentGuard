'use client';

import { useState } from 'react';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/live';
import { formatDateTime } from '@/lib/format';
import type { AuditRow, Paged } from '@/lib/types';
import type { VerifyOutcome } from '@/components/IntegrityCheckButton';
import { IntegrityCheckButton } from '@/components/IntegrityCheckButton';
import type { ChainState } from '@/components/LogTable';
import { LogTable } from '@/components/LogTable';
import { Alert, Button, EmptyState, ErrorState, PageHeader, Pagination, Skeleton } from '@/components/ui';

const EVENT_TYPES = [
  'call_received',
  'score_computed',
  'decision_made',
  'approval_requested',
  'approval_resolved',
  'tool_executed',
  'tool_not_executed',
  'request_rejected',
  'admin_login',
  'admin_login_failed',
  'admin_logout',
  'demo_scenario_triggered',
];
const PAGE_SIZE = 30;

export default function AuditLogPage() {
  const [page, setPage] = useState(1);
  const [eventType, setEventType] = useState('');
  const [focusSeq, setFocusSeq] = useState<number | null>(null);
  const [verify, setVerify] = useState<VerifyOutcome | null>(null);
  const [verifying, setVerifying] = useState(false);

  const query = `page_size=${PAGE_SIZE}&${focusSeq ? `focus_seq=${focusSeq}` : `page=${page}`}${eventType ? `&event_type=${eventType}` : ''}`;
  const { data, error, loading, refresh } = useLiveData(() => api<Paged<AuditRow>>(`/api/audit-log?${query}`), query);
  // Once the jump-to page has loaded, keep paging normally from there.
  if (focusSeq && data && data.page !== page) setPage(data.page);

  const chain: ChainState = verifying
    ? { kind: 'verifying' }
    : verify?.kind === 'result' && verify.result.status === 'tampered'
      ? { kind: 'broken', seq: verify.result.broken_seq! }
      : verify?.kind === 'result' && verify.result.valid
        ? { kind: 'valid' }
        : { kind: 'idle' };
  const result = verify?.kind === 'result' ? verify.result : null;

  return (
    <>
      <PageHeader title="Audit Log">
        <IntegrityCheckButton
          onStart={() => {
            setVerifying(true);
            setVerify(null);
          }}
          onDone={(o) => {
            setVerifying(false);
            setVerify(o);
          }}
        />
      </PageHeader>

      {/* Persistent verification result (spec §5 S-06), announced politely (spec §7). */}
      <div aria-live="polite" className="mb-4 empty:hidden" data-testid="verify-result">
        {verify?.kind === 'error' && (
          <Alert tone="warning" title="Couldn't run the integrity check" action={<Button variant="secondary" compact onClick={() => setVerify(null)}>Dismiss</Button>}>
            {verify.message} This is NOT a tamper result — the chain was not evaluated. Retry once the server is reachable.
          </Alert>
        )}
        {result?.status === 'valid' && (
          <Alert tone="success" title={`PASS — chain valid as of ${formatDateTime(result.checked_at)}`}>
            All {result.verified_rows} rows recomputed and linked correctly.
          </Alert>
        )}
        {result?.status === 'empty' && <Alert tone="info" title="Nothing to verify">The audit log is empty.</Alert>}
        {result?.status === 'tampered' && (
          <Alert
            tone="error"
            title={`FAIL — tampered row detected at #${result.broken_seq}`}
            action={
              <Button
                variant="secondary"
                compact
                onClick={() => {
                  setEventType('');
                  setFocusSeq(result.broken_seq);
                }}
              >
                Show row #{result.broken_seq}
              </Button>
            }
          >
            {result.message} {result.verified_rows} of {result.total_rows} rows verified before the break (reason: {result.reason}).
          </Alert>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="type-label" htmlFor="event-filter">
          Event type
        </label>
        <select
          id="event-filter"
          value={eventType}
          onChange={(e) => {
            setEventType(e.target.value);
            setFocusSeq(null);
            setPage(1);
          }}
          className="h-9 rounded-sm border border-border bg-raised px-2 text-text"
        >
          <option value="">All events</option>
          {EVENT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {data && <span className="type-caption">{data.total} entries · append-only · newest first</span>}
      </div>

      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={refresh} />
        </div>
      )}
      {loading && !data ? (
        <div className="space-y-2">
          {Array.from({ length: 10 }, (_, i) => (
            <Skeleton key={i} className="h-14 w-full" />
          ))}
        </div>
      ) : data && data.items.length === 0 ? (
        <EmptyState>No log entries yet.</EmptyState>
      ) : data ? (
        <>
          <LogTable rows={data.items} chain={eventType ? { kind: 'idle' } : chain} isLastPage={data.page >= data.total_pages} />
          <Pagination
            page={data.page}
            totalPages={data.total_pages}
            onChange={(p) => {
              setFocusSeq(null);
              setPage(p);
            }}
          />
        </>
      ) : null}
    </>
  );
}
