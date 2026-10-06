'use client';

import { useState } from 'react';
import { ApiError, api } from '@/lib/api';
import type { VerifyResult } from '@/lib/types';
import { Button } from './ui';
import { ShieldIcon } from './icons';

export type VerifyOutcome = { kind: 'result'; result: VerifyResult } | { kind: 'error'; message: string };

/**
 * Runs the real hash-chain check (GET /api/audit-log/verify). Reports "could not run the
 * check" separately from "chain is tampered" — they must never look the same (spec §3).
 */
export function IntegrityCheckButton({ onStart, onDone }: { onStart: () => void; onDone: (o: VerifyOutcome) => void }) {
  const [running, setRunning] = useState(false);
  async function run() {
    setRunning(true);
    onStart();
    try {
      onDone({ kind: 'result', result: await api<VerifyResult>('/api/audit-log/verify') });
    } catch (e) {
      onDone({ kind: 'error', message: (e as ApiError).message });
    } finally {
      setRunning(false);
    }
  }
  return (
    <Button onClick={run} loading={running}>
      <ShieldIcon />
      Verify integrity
    </Button>
  );
}
