import { formatScore } from '@/lib/format';

/** Bands match the Rego thresholds exactly (<30 allow / 30–70 approve / >=70 block). */
export const ALLOW_BELOW = 30;
export const BLOCK_AT = 70;

function band(score: number) {
  if (score >= BLOCK_AT) return { color: 'bg-error', label: 'high' };
  if (score >= ALLOW_BELOW) return { color: 'bg-warning', label: 'medium' };
  return { color: 'bg-success', label: 'low' };
}

function Bar({ score, label, note }: { score: number | null; label?: string; note?: string }) {
  const b = score === null ? null : band(score);
  return (
    <div className="flex items-center gap-3" role="img" aria-label={`${label ?? 'Risk'} ${score === null ? 'not available' : `${formatScore(score)} of 100, ${b!.label}`}`}>
      {label && <span className="type-label w-24 shrink-0">{label}</span>}
      <div className="relative h-2 min-w-16 flex-1 rounded-full bg-raised">
        {score !== null && <div className={`absolute inset-y-0 left-0 rounded-full ${b!.color}`} style={{ width: `${Math.max(2, Math.min(100, score))}%` }} />}
        {/* threshold ticks */}
        <span className="absolute inset-y-[-2px] w-px bg-muted/50" style={{ left: `${ALLOW_BELOW}%` }} aria-hidden="true" />
        <span className="absolute inset-y-[-2px] w-px bg-muted/50" style={{ left: `${BLOCK_AT}%` }} aria-hidden="true" />
      </div>
      <span className="type-data w-12 shrink-0 text-right">{formatScore(score)}</span>
      {note && <span className="type-caption w-40 shrink-0">{note}</span>}
    </div>
  );
}

export function RiskMeter({
  final,
  rule,
  injection,
  injectionNote,
  variant = 'compact',
}: {
  final: number | null;
  rule?: number | null;
  injection?: number | null;
  injectionNote?: string;
  variant?: 'compact' | 'expanded';
}) {
  if (variant === 'compact') return <Bar score={final} />;
  return (
    <div className="space-y-3">
      <Bar label="Rule" score={rule ?? null} />
      <Bar label="Injection" score={injection ?? null} note={injectionNote} />
      <Bar label="Final" score={final} />
      <p className="type-caption">
        Bands: &lt;{ALLOW_BELOW} allow · {ALLOW_BELOW}–{BLOCK_AT} human review · ≥{BLOCK_AT} block (same thresholds as the OPA policy).
      </p>
    </div>
  );
}
