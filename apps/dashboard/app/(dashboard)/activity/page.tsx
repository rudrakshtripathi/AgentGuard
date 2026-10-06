'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/live';
import type { CallStatus, CallSummary, Paged } from '@/lib/types';
import { LiveFeedRow } from '@/components/LiveFeedRow';
import { LiveIndicator } from '@/components/Shell';
import { EmptyState, ErrorState, PageHeader, Pagination, Skeleton } from '@/components/ui';

const FILTERS: { value: '' | CallStatus; label: string }[] = [
  { value: '', label: 'All statuses' },
  { value: 'allowed', label: 'Allowed' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'pending', label: 'Pending approval' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'timeout_denied', label: 'Timed out — denied' },
  { value: 'in_progress', label: 'In progress' },
];
const PAGE_SIZE = 25;

export default function ActivityPage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<'' | CallStatus>('');
  const query = `page=${page}&page_size=${PAGE_SIZE}${status ? `&status=${status}` : ''}`;
  const { data, error, loading, refresh } = useLiveData(() => api<Paged<CallSummary>>(`/api/tool-calls?${query}`), query);

  // Track ids already shown so only genuinely new rows get the highlight-fade.
  const [track, setTrack] = useState<{ data: typeof data; known: Set<string>; fresh: Set<string> }>({ data: null, known: new Set(), fresh: new Set() });
  if (data && data !== track.data) {
    const fresh = track.data ? new Set(data.items.filter((c) => !track.known.has(c.id)).map((c) => c.id)) : new Set<string>();
    const known = new Set(track.known);
    data.items.forEach((c) => known.add(c.id));
    setTrack({ data, known, fresh });
  }
  const newIds = track.fresh;

  return (
    <>
      <PageHeader title="Activity">
        <LiveIndicator />
        <label className="sr-only" htmlFor="status-filter">
          Filter by status
        </label>
        <select
          id="status-filter"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as '' | CallStatus);
            setPage(1);
          }}
          className="h-9 rounded-sm border border-border bg-raised px-2 text-text"
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </PageHeader>

      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={refresh} />
        </div>
      )}

      {loading && !data ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      ) : data && data.items.length === 0 ? (
        <EmptyState>
          {status ? (
            'No calls match this filter.'
          ) : (
            <>
              No calls yet. Trigger a scenario from the{' '}
              <Link className="text-primary hover:underline" href="/demo">
                Demo panel
              </Link>{' '}
              to see one here.
            </>
          )}
        </EmptyState>
      ) : data ? (
        <>
          <div className="overflow-x-auto rounded-md border border-border bg-surface">
            <table className="w-full border-collapse text-left">
              <caption className="sr-only">Tool calls, newest first</caption>
              <thead>
                <tr className="border-b border-border">
                  <th scope="col" className="type-label py-2 pl-4 pr-3">Time</th>
                  <th scope="col" className="type-label hidden px-3 py-2 desktop:table-cell">Agent</th>
                  <th scope="col" className="type-label px-3 py-2">Tool</th>
                  <th scope="col" className="type-label hidden px-3 py-2 tablet:table-cell">Target</th>
                  <th scope="col" className="type-label px-3 py-2">Risk</th>
                  <th scope="col" className="type-label py-2 pl-3 pr-4">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c) => (
                  <LiveFeedRow key={c.id} call={c} isNew={newIds.has(c.id)} />
                ))}
              </tbody>
            </table>
          </div>
          <p className="type-caption mt-2">{data.total} calls</p>
          <Pagination page={data.page} totalPages={data.total_pages} onChange={setPage} />
        </>
      ) : null}
    </>
  );
}
