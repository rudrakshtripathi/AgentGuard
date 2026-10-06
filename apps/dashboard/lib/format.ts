export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatRelative(iso: string, now = Date.now()): string {
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function truncateHash(hash: string | null, n = 4): string {
  if (!hash) return '—';
  return hash.length <= n * 2 + 1 ? hash : `${hash.slice(0, n)}…${hash.slice(-n)}`;
}

const str = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(', ') : '');

/** The human-readable "target" of a call (recipient, path, query, payee). */
export function describeTarget(tool: string, params: Record<string, unknown>): string {
  switch (tool) {
    case 'send_email':
      return str(params.to) || '(no recipient)';
    case 'delete_file':
      return [str(params.path), str(params.paths)].filter(Boolean).join(', ') + (params.recursive === true ? ' (recursive)' : '') || '(no path)';
    case 'run_db_query':
      return str(params.query) || '(no query)';
    case 'process_payment':
      return `${str(params.recipient) || '(no recipient)'}${typeof params.amount === 'number' ? ` · ${params.amount.toLocaleString()} ${str(params.currency) || 'USD'}` : ''}`;
    default:
      return Object.keys(params).length ? JSON.stringify(params).slice(0, 80) : '(no params)';
  }
}

export function formatScore(n: number | null | undefined): string {
  return n === null || n === undefined ? '—' : n.toFixed(1);
}
