'use client';

import Link from 'next/link';
import { api } from '@/lib/api';
import { useLiveData } from '@/lib/live';
import type { ScenarioInfo } from '@/lib/types';
import { ScenarioTriggerButton } from '@/components/ScenarioTriggerButton';
import { Card, ErrorState, PageHeader, Skeleton } from '@/components/ui';
import { LiveIndicator } from '@/components/Shell';

export default function DemoPage() {
  const { data, error, loading, refresh } = useLiveData(() => api<{ items: ScenarioInfo[] }>('/api/demo/scenarios'), 'scenarios');
  return (
    <>
      <PageHeader title="Demo">
        <LiveIndicator />
      </PageHeader>
      <p className="-mt-4 mb-6 text-muted">
        Runs the real pipeline with scripted input: real interceptor, risk scoring, OPA decision, database writes and hash-chained audit log. Only the input
        is pre-written; no LLM is called.
      </p>
      {error && <ErrorState error={error} onRetry={refresh} />}
      <div className="grid gap-4 tablet:grid-cols-2 desktop:grid-cols-3">
        {loading && !data
          ? Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-56" />)
          : data?.items.map((s) => <ScenarioTriggerButton key={s.name} scenario={s} />)}

        {/* Tamper test: deliberately NOT an app button — the app has no write path to audit_log. */}
        <Card className="p-5">
          <h2 className="type-h3">Tamper test</h2>
          <p className="mt-1 text-muted">Edit an audit row directly in Postgres, then watch the verifier catch it.</p>
          <p className="type-caption mt-2">
            The application has no update path to the audit log (by design), so this runs as a separate owner-role script — exactly what an attacker with
            database access would have to do.
          </p>
          <ol className="mt-3 list-decimal space-y-2 pl-5">
            <li>
              In a terminal: <code className="type-data rounded-sm bg-bg px-1.5 py-0.5">npm run demo:tamper</code>
            </li>
            <li>
              Open{' '}
              <Link className="text-primary hover:underline" href="/audit-log">
                Audit Log
              </Link>{' '}
              and click <strong>Verify integrity</strong> → FAIL at the edited row.
            </li>
            <li>
              Restore: <code className="type-data rounded-sm bg-bg px-1.5 py-0.5">npm run demo:tamper -- --restore</code> → verify again → PASS.
            </li>
          </ol>
        </Card>
      </div>
    </>
  );
}
