'use client';

import { useState } from 'react';
import type { Stats } from '@/lib/types';

/**
 * Calls over time: stacked bars, one bar per bucket, segments = outcome status.
 * The series ARE statuses, so they use the reserved status tokens (allowed teal / blocked
 * red / pending amber) — validated for CVD separation (min ΔE 16) and >=3:1 contrast on
 * the surface — and identity is never colour-alone: legend + per-bar tooltip + table view.
 */
const SERIES = [
  { key: 'allowed', label: 'Allowed', color: 'var(--color-success)' },
  { key: 'blocked', label: 'Blocked', color: 'var(--color-error)' },
  { key: 'pending', label: 'Pending / in progress', color: 'var(--color-warning)' },
] as const;

const H = 210;
const PAD_TOP = 10;
const PAD_LEFT = 32;
const PAD_BOTTOM = 22;
const GAP = 2; // surface gap between stacked segments

export function CallsChart({ stats }: { stats: Stats }) {
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const data = stats.series;
  const max = Math.max(4, ...data.map((d) => d.total));
  const niceMax = Math.ceil(max / 4) * 4;
  const W = 760;
  const plotW = W - PAD_LEFT;
  const plotH = H - PAD_BOTTOM - PAD_TOP;
  const slot = plotW / data.length;
  const barW = Math.max(4, Math.min(28, slot * 0.62));
  const y = (v: number) => (v / niceMax) * plotH;
  const fmt = (iso: string) =>
    stats.range === '24h'
      ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', hour12: false })
      : new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
  const hovered = hover === null ? null : data[hover];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <ul className="flex flex-wrap gap-4" aria-label="Legend">
          {SERIES.map((s) => (
            <li key={s.key} className="flex items-center gap-2 text-sm text-muted">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
              {s.label}
            </li>
          ))}
        </ul>
        <button type="button" className="text-sm text-primary hover:underline" onClick={() => setAsTable((t) => !t)}>
          {asTable ? 'Show chart' : 'Show as table'}
        </button>
      </div>

      {asTable ? (
        <div className="max-h-64 overflow-auto rounded-sm border border-border">
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-raised">
              <tr>
                {['Bucket', 'Total', 'Allowed', 'Blocked', 'Pending'].map((h) => (
                  <th key={h} scope="col" className="type-label px-3 py-1.5">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.bucket} className="border-t border-border/60">
                  <td className="type-data px-3 py-1">{fmt(d.bucket)}</td>
                  <td className="type-data px-3 py-1">{d.total}</td>
                  <td className="type-data px-3 py-1">{d.allowed}</td>
                  <td className="type-data px-3 py-1">{d.blocked}</td>
                  <td className="type-data px-3 py-1">{d.pending}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative">
          <svg viewBox={`0 ${-PAD_TOP} ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Calls over the last ${stats.range}: ${stats.total} total. Use "Show as table" for exact values.`}>
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line x1={PAD_LEFT} x2={W} y1={plotH - f * plotH} y2={plotH - f * plotH} stroke="var(--color-border)" strokeWidth={1} />
                <text x={PAD_LEFT - 6} y={plotH - f * plotH + 4} textAnchor="end" fontSize={11} fill="var(--color-muted)">
                  {Math.round(f * niceMax)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const cx = PAD_LEFT + slot * i + slot / 2;
              let acc = 0;
              const segs = SERIES.map((s) => ({ ...s, v: d[s.key] })).filter((s) => s.v > 0);
              return (
                <g key={d.bucket} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                  {/* hit target wider than the mark */}
                  <rect x={PAD_LEFT + slot * i} y={0} width={slot} height={plotH} fill="transparent" />
                  {segs.map((s, si) => {
                    const h = y(s.v);
                    const top = plotH - acc - h;
                    acc += h;
                    const isTop = si === segs.length - 1;
                    const segH = Math.max(1, h - (isTop ? 0 : GAP));
                    return (
                      <rect
                        key={s.key}
                        x={cx - barW / 2}
                        y={top + (isTop ? 0 : GAP)}
                        width={barW}
                        height={segH}
                        rx={isTop ? Math.min(4, segH / 2) : 0}
                        fill={s.color}
                        opacity={hover === null || hover === i ? 1 : 0.45}
                      />
                    );
                  })}
                  {(stats.range === '7d' || i % 4 === 0 || i === data.length - 1) && (
                    <text x={cx} y={H - 6} textAnchor="middle" fontSize={11} fill="var(--color-muted)">
                      {fmt(d.bucket)}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
          {hovered && hover !== null && (
            <div
              className="pointer-events-none absolute top-2 z-10 rounded-md border border-border bg-raised px-3 py-2 text-sm shadow-[var(--shadow-2)]"
              style={{ left: `${Math.min(80, ((PAD_LEFT + slot * hover + slot / 2) / W) * 100)}%` }}
            >
              <p className="type-label mb-1">{fmt(hovered.bucket)}</p>
              <p className="type-data">{hovered.total} calls</p>
              {SERIES.map((s) => (
                <p key={s.key} className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
                  <span className="text-muted">{s.label}</span>
                  <span className="type-data ml-auto pl-3">{hovered[s.key]}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
