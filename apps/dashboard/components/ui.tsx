'use client';

import { useEffect, useRef } from 'react';
import { AlertIcon, InfoIcon, SpinnerIcon } from './icons';

type ButtonVariant = 'primary' | 'secondary' | 'destructive' | 'ghost';
const variants: Record<ButtonVariant, string> = {
  primary: 'bg-primary text-on-accent hover:brightness-110 active:brightness-90',
  secondary: 'border border-border text-text hover:bg-raised active:brightness-90',
  destructive: 'bg-error text-white hover:brightness-110 active:brightness-90',
  ghost: 'text-muted hover:text-text hover:bg-raised',
};

export function Button({
  variant = 'primary',
  loading = false,
  compact = false,
  className = '',
  children,
  disabled,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; loading?: boolean; compact?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`relative inline-flex items-center justify-center gap-2 rounded-sm px-4 font-medium transition-[filter,background-color,color] duration-150 ease-out active:translate-y-px disabled:pointer-events-none disabled:opacity-40 ${
        compact ? 'h-9' : 'h-10'
      } ${variants[variant]} ${className}`}
    >
      {/* Width is locked by keeping the label in the layout while loading. */}
      <span className={`inline-flex items-center gap-2 ${loading ? 'invisible' : ''}`}>{children}</span>
      {loading && (
        <span className="absolute inset-0 flex items-center justify-center">
          <SpinnerIcon />
        </span>
      )}
    </button>
  );
}

/** Page title; receives focus on navigation (spec §7 focus management). */
export function PageHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  return (
    <header className="mb-6 flex flex-wrap items-center justify-between gap-4">
      <h1 ref={ref} tabIndex={-1} className="type-h1 outline-none">
        {title}
      </h1>
      {children && <div className="flex flex-wrap items-center gap-3">{children}</div>}
    </header>
  );
}

type Tone = 'info' | 'warning' | 'error' | 'success';
const toneClasses: Record<Tone, string> = {
  info: 'border-info/50 bg-info/10',
  warning: 'border-warning/50 bg-warning/10',
  error: 'border-error/60 bg-error/10',
  success: 'border-success/50 bg-success/10',
};
const toneIcon: Record<Tone, string> = { info: 'text-info', warning: 'text-warning', error: 'text-error', success: 'text-success' };

export function Alert({ tone, title, children, action, live }: { tone: Tone; title: string; children?: React.ReactNode; action?: React.ReactNode; live?: 'polite' | 'assertive' }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} aria-live={live} className={`flex items-start gap-3 rounded-md border px-4 py-3 ${toneClasses[tone]}`}>
      <span className={`mt-0.5 ${toneIcon[tone]}`}>{tone === 'info' || tone === 'success' ? <InfoIcon /> : <AlertIcon />}</span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {children && <div className="mt-0.5 text-muted">{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="rounded-md border border-dashed border-border px-6 py-10 text-center text-muted">{children}</div>;
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <Alert
      tone="error"
      title="Couldn't load this data."
      action={onRetry && <Button variant="secondary" compact onClick={onRetry}>Retry</Button>}
    >
      {error.message}
    </Alert>
  );
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-sm bg-raised ${className}`} aria-hidden="true" />;
}

export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <section className={`rounded-md border border-border bg-surface shadow-[var(--shadow-1)] ${className}`}>{children}</section>;
}

export function Pagination({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (p: number) => void }) {
  return (
    <nav aria-label="Pagination" className="mt-4 flex items-center justify-end gap-3">
      <Button variant="secondary" compact disabled={page <= 1} onClick={() => onChange(page - 1)}>
        Previous
      </Button>
      <span className="type-data text-muted">
        Page {page} of {totalPages}
      </span>
      <Button variant="secondary" compact disabled={page >= totalPages} onClick={() => onChange(page + 1)}>
        Next
      </Button>
    </nav>
  );
}
