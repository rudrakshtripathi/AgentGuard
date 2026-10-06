'use client';

import { useRouter } from 'next/navigation';
import { describeTarget, formatRelative, formatTime } from '@/lib/format';
import type { CallSummary } from '@/lib/types';
import { RiskMeter } from './RiskMeter';
import { StatusBadge } from './StatusBadge';

/** One call in the live feed. Click or Enter opens the call detail. New rows highlight-fade in. */
export function LiveFeedRow({ call, isNew }: { call: CallSummary; isNew: boolean }) {
  const router = useRouter();
  const open = () => router.push(`/calls/${call.id}?from=activity`);
  // Agent-submitted values are rendered as React text nodes only (never as HTML).
  const target = describeTarget(call.tool_name, call.params);
  return (
    <tr
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      }}
      data-call-id={call.id}
      aria-label={`${call.tool_name} by ${call.agent_name}, ${call.status.replace('_', ' ')}. Open details.`}
      className={`cursor-pointer border-b border-border transition-colors duration-150 hover:bg-raised focus-visible:bg-raised ${isNew ? 'row-enter' : ''}`}
    >
      <td className="type-data whitespace-nowrap py-2.5 pl-4 pr-3" title={call.requested_at}>
        <span className="hidden tablet:inline">{formatTime(call.requested_at)}</span>
        <span className="tablet:hidden">{formatRelative(call.requested_at)}</span>
      </td>
      <td className="hidden px-3 py-2.5 desktop:table-cell">{call.agent_name}</td>
      <td className="type-data px-3 py-2.5">{call.tool_name}</td>
      <td className="hidden max-w-[320px] truncate px-3 py-2.5 text-muted tablet:table-cell" title={target}>
        {target}
      </td>
      <td className="w-44 px-3 py-2.5">
        <RiskMeter final={call.final_score} />
      </td>
      <td className="py-2.5 pl-3 pr-4">
        <StatusBadge status={call.status} />
      </td>
    </tr>
  );
}
