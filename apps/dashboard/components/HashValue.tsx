'use client';

import { useState } from 'react';
import { truncateHash } from '@/lib/format';

/**
 * Truncated hash (a3f2…9c01) that expands on click / Enter to show the full value.
 * Keyboard-reachable; the full value is also the accessible name and the title tooltip.
 */
export function HashValue({ value, label }: { value: string | null; label: string }) {
  const [open, setOpen] = useState(false);
  if (!value) return <span className="type-data text-muted">— (genesis)</span>;
  return (
    <button
      type="button"
      onClick={() => setOpen((o) => !o)}
      title={value}
      aria-label={`${label}: ${value}`}
      aria-expanded={open}
      className="type-data rounded-sm text-left text-text hover:text-primary"
    >
      {open ? <span className="break-all">{value}</span> : truncateHash(value)}
    </button>
  );
}
