'use client';

import Link from 'next/link';
import { formatDateTime } from '@/lib/format';
import type { AuditRow } from '@/lib/types';
import { HashValue } from './HashValue';

export type ChainState = { kind: 'idle' } | { kind: 'verifying' } | { kind: 'valid' } | { kind: 'broken'; seq: number };

/**
 * The append-only ledger with its hash chain made visible (spec §3 LogTable/HashChainRow).
 * Rows are newest-first: each row's prev_hash (bottom line) is the hash of the row below,
 * and the connector threads down into it. During verification the connectors pulse; after,
 * they turn success-teal, except the first broken row, which turns red.
 */
function Connector({ state, seq, last }: { state: ChainState; seq: number; last: boolean }) {
  const broken = state.kind === 'broken' && state.seq === seq;
  const color =
    broken ? 'bg-error' : state.kind === 'valid' || (state.kind === 'broken' && seq < state.seq) ? 'bg-success' : 'bg-border';
  const pulse = state.kind === 'verifying' ? 'chain-pulse' : '';
  return (
    <div className="relative flex h-full w-6 justify-center" aria-hidden="true">
      <span className={`absolute top-0 ${last ? 'h-1/2' : 'bottom-0'} w-0.5 ${color} ${pulse}`} />
      <span className={`absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-surface ${color} ${pulse}`} />
    </div>
  );
}

const summarize = (row: AuditRow): string => {
  const p = row.payload_json;
  const parts = [p.tool_name, p.decision, p.status, p.policy_name, p.reason, p.scenario, p.username].filter((x) => typeof x === 'string');
  if (typeof p.final_score === 'number') parts.push(`final ${p.final_score}`);
  if (typeof p.executed === 'boolean') parts.push(p.executed ? 'executed' : 'not executed');
  return parts.join(' · ');
};

export function LogTable({ rows, chain, isLastPage }: { rows: AuditRow[]; chain: ChainState; isLastPage: boolean }) {
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-surface">
      <table className="w-full min-w-[860px] border-collapse">
        <caption className="sr-only">Audit log entries, newest first, with hash chain links</caption>
        <thead>
          <tr className="border-b border-border text-left">
            <th className="type-label w-10 py-2 pl-4" scope="col">
              <span className="sr-only">Chain</span>
            </th>
            <th className="type-label px-3 py-2" scope="col">#</th>
            <th className="type-label px-3 py-2" scope="col">Time</th>
            <th className="type-label px-3 py-2" scope="col">Event</th>
            <th className="type-label px-3 py-2" scope="col">Summary</th>
            <th className="type-label px-3 py-2 pr-4" scope="col">Hash / prev</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const broken = chain.kind === 'broken' && chain.seq === row.seq;
            return (
              <tr key={row.id} data-seq={row.seq} data-broken={broken || undefined} className={`border-b border-border/60 ${broken ? 'bg-error/10' : ''}`}>
                <td className="h-14 py-0 pl-4">
                  <Connector state={chain} seq={row.seq} last={isLastPage && i === rows.length - 1} />
                </td>
                <td className="type-data px-3 text-muted">{row.seq}</td>
                <td className="type-data whitespace-nowrap px-3">{formatDateTime(row.created_at)}</td>
                <td className="type-data px-3">
                  {row.event_type}
                  {broken && <span className="ml-2 rounded-full bg-error px-2 py-0.5 text-xs font-medium text-white">Tampered</span>}
                </td>
                <td className="max-w-[340px] truncate px-3 text-muted">
                  {row.referenced_call_id ? (
                    <Link className="text-primary hover:underline" href={`/calls/${row.referenced_call_id}?from=audit-log`}>
                      {summarize(row) || 'view call'}
                    </Link>
                  ) : (
                    summarize(row)
                  )}
                </td>
                <td className="px-3 pr-4 leading-tight">
                  <div>
                    <HashValue value={row.hash} label={`Hash of row ${row.seq}`} />
                  </div>
                  <div className="type-caption">
                    prev <HashValue value={row.prev_hash} label={`Previous hash of row ${row.seq}`} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
