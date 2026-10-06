'use client';

import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/live';
import type { Stats } from '@/lib/types';
import { CallsChart } from '@/components/CallsChart';
import { LiveIndicator } from '@/components/Shell';
import { Card, ErrorState, PageHeader, Skeleton } from '@/components/ui';

const CARDS = [
  { key: 'total', label: 'Total calls', accent: 'bg-secondary', hint: 'All intercepted tool calls' },
  { key: 'allowed', label: 'Allowed', accent: 'bg-success', hint: 'Allowed by policy or approved by a human' },
  { key: 'blocked', label: 'Blocked', accent: 'bg-error', hint: 'Blocked, rejected or timed out' },
  { key: 'pending', label: 'Pending', accent: 'bg-warning', hint: 'Waiting for a human decision' },
] as const;

export default function OverviewPage() {
  const [range, setRange] = useState<'24h' | '7d'>('24h');
  const { data, error, loading, refresh } = useLiveData(() => api<Stats>(`/api/stats?range=${range}`), range);

  return (
    <>
      <PageHeader title="Overview">
        <LiveIndicator />
        <span className="type-caption" suppressHydrationWarning>{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</span>
      </PageHeader>
      {error && (
        <div className="mb-4">
          <ErrorState error={error} onRetry={refresh} />
        </div>
      )}
      <div className="grid grid-cols-2 gap-4 desktop:grid-cols-4">
        {CARDS.map((c) => (
          <Card key={c.key} className="relative overflow-hidden p-5">
            <span className={`absolute inset-y-0 left-0 w-1 ${c.accent}`} aria-hidden="true" />
            <p className="type-label">{c.label}</p>
            {loading && !data ? (
              <Skeleton className="mt-2 h-9 w-20" />
            ) : (
              // "—" means unknown (fetch failed); 0 is a real value (spec §5 S-02).
              <p className="mt-1 font-display text-3xl font-semibold" data-stat={c.key}>
                {data ? data[c.key] : '—'}
              </p>
            )}
            <p className="type-caption mt-1">{c.hint}</p>
          </Card>
        ))}
      </div>

      <Card className="mt-6 p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="type-h2">Calls over time</h2>
          <div role="group" aria-label="Time range" className="flex rounded-sm border border-border">
            {(['24h', '7d'] as const).map((r) => (
              <button
                key={r}
                type="button"
                aria-pressed={range === r}
                onClick={() => setRange(r)}
                className={`h-8 px-3 text-sm ${range === r ? 'bg-raised font-semibold text-text' : 'text-muted hover:text-text'}`}
              >
                {r === '24h' ? 'Last 24 hours' : 'Last 7 days'}
              </button>
            ))}
          </div>
        </div>
        {loading && !data ? <Skeleton className="h-52 w-full" /> : data ? <CallsChart stats={data} /> : null}
        {data && data.total === 0 && (
          <p className="mt-4 text-muted">
            No calls yet. Trigger a scenario from the{' '}
            <Link className="text-primary hover:underline" href="/demo">
              Demo panel
            </Link>{' '}
            to see one here.
          </p>
        )}
      </Card>
    </>
  );
}
