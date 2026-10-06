import type { CallStatus } from '@/lib/types';
import { CheckIcon, ClockIcon, ClockXIcon, SpinnerIcon, XIcon } from './icons';

/**
 * Decision / resolution state. Always colour + icon + text (spec §1 principle 2);
 * timeout-denied is visually distinct from a human rejection.
 */
const styles: Record<CallStatus, { label: string; cls: string; Icon: (p: { className?: string }) => React.ReactElement }> = {
  allowed: { label: 'Allowed', cls: 'bg-primary text-on-accent', Icon: CheckIcon },
  approved: { label: 'Approved', cls: 'bg-primary text-on-accent', Icon: CheckIcon },
  blocked: { label: 'Blocked', cls: 'bg-error text-white', Icon: XIcon },
  rejected: { label: 'Rejected', cls: 'bg-error text-white', Icon: XIcon },
  timeout_denied: { label: 'Timed out — denied', cls: 'border border-error text-error', Icon: ClockXIcon },
  pending: { label: 'Pending approval', cls: 'bg-warning text-on-accent', Icon: ClockIcon },
  in_progress: { label: 'In progress', cls: 'border border-secondary text-secondary', Icon: SpinnerIcon },
};

export function StatusBadge({ status }: { status: CallStatus }) {
  const s = styles[status];
  return (
    <span data-status={status} className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${s.cls}`}>
      <s.Icon className="h-3.5 w-3.5" />
      {s.label}
    </span>
  );
}
