'use client';

import { api } from '@/lib/api';
import { useLiveData } from '@/lib/live';
import type { PendingApproval } from '@/lib/types';
import { ApprovalCard } from '@/components/ApprovalCard';
import { LiveIndicator } from '@/components/Shell';
import { EmptyState, ErrorState, PageHeader, Skeleton } from '@/components/ui';

export default function ApprovalsPage() {
  const { data, error, loading, refresh } = useLiveData(() => api<{ items: PendingApproval[]; timeout_seconds: number }>('/api/approvals/pending'));
  const count = data?.items.length ?? 0;
  return (
    <>
      <PageHeader title="Approvals">
        <span className="rounded-full bg-warning px-2.5 py-0.5 text-xs font-medium text-on-accent" data-pending-count={count} aria-live="polite">
          {count} pending
        </span>
        <LiveIndicator />
      </PageHeader>
      {data && (
        <p className="type-caption -mt-4 mb-4">
          Unresolved items are denied automatically after {data.timeout_seconds}s — a missed item never silently runs.
        </p>
      )}
      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={refresh} />
        </div>
      )}
      {loading && !data ? (
        <div className="space-y-4">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : data && data.items.length === 0 ? (
        <EmptyState>No pending approvals. Actions requiring review will appear here.</EmptyState>
      ) : (
        <div className="space-y-4">
          {data?.items.map((item) => (
            <ApprovalCard key={item.approval_id} item={item} onResolved={refresh} />
          ))}
        </div>
      )}
    </>
  );
}
