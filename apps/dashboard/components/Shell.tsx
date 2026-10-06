'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useLive } from '@/lib/live';
import { GridIcon, InboxIcon, LedgerIcon, LogoutIcon, MenuIcon, PlayIcon, PulseIcon, ShieldIcon } from './icons';

const NAV = [
  { href: '/', label: 'Overview', Icon: GridIcon },
  { href: '/activity', label: 'Activity', Icon: PulseIcon },
  { href: '/approvals', label: 'Approvals', Icon: InboxIcon },
  { href: '/audit-log', label: 'Audit Log', Icon: LedgerIcon },
  { href: '/demo', label: 'Demo', Icon: PlayIcon },
];

export function LiveIndicator() {
  const { mode } = useLive();
  const text = mode === 'live' ? 'Live' : mode === 'polling' ? 'Live channel lost — polling every 2.5s' : 'Connecting…';
  return (
    <span data-live-mode={mode} role="status" className="inline-flex items-center gap-2 text-xs text-muted">
      <span className="relative flex h-2.5 w-2.5" aria-hidden="true">
        {mode === 'live' && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />}
        <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${mode === 'live' ? 'bg-primary' : mode === 'polling' ? 'bg-warning' : 'bg-muted'}`} />
      </span>
      {text}
    </span>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const active = (href: string) => (href === '/' ? pathname === '/' : pathname.startsWith(href)) || (href === '/activity' && pathname.startsWith('/calls'));

  async function logout() {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.assign('/login');
  }

  return (
    <div className="min-h-screen desktop:pl-60 tablet:pl-16">
      {/* Sidebar: 240px on desktop, icon rail on tablet, top bar on mobile (spec §4). */}
      <aside className="fixed inset-x-0 top-0 z-30 flex flex-col border-b border-border bg-surface tablet:inset-y-0 tablet:right-auto tablet:w-16 tablet:border-b-0 tablet:border-r desktop:w-60">
        <div className="flex h-14 items-center justify-between px-4 tablet:justify-center desktop:justify-start desktop:gap-2">
          <span className="flex items-center gap-2 font-display text-lg font-semibold">
            <ShieldIcon className="h-5 w-5 text-primary" />
            <span className="tablet:hidden desktop:inline">AgentGuard</span>
          </span>
          <button type="button" className="text-muted tablet:hidden" aria-label="Toggle navigation" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
            <MenuIcon className="h-5 w-5" />
          </button>
        </div>
        <nav aria-label="Primary" className={`${menuOpen ? 'flex' : 'hidden'} flex-1 flex-col gap-1 px-2 pb-3 tablet:flex`}>
          {NAV.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setMenuOpen(false)}
              aria-current={active(href) ? 'page' : undefined}
              title={label}
              className={`group flex h-10 items-center gap-3 rounded-sm border-l-2 px-3 transition-colors duration-150 tablet:justify-center desktop:justify-start ${
                active(href) ? 'border-primary bg-raised font-semibold text-text' : 'border-transparent text-muted hover:bg-raised hover:text-text'
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="tablet:sr-only desktop:not-sr-only">{label}</span>
            </Link>
          ))}
          <div className="mt-auto" />
          <button
            type="button"
            onClick={logout}
            title="Log out"
            className="flex h-10 items-center gap-3 rounded-sm border-l-2 border-transparent px-3 text-muted hover:bg-raised hover:text-text tablet:justify-center desktop:justify-start"
          >
            <LogoutIcon className="h-4 w-4" />
            <span className="tablet:sr-only desktop:not-sr-only">Log out</span>
          </button>
        </nav>
      </aside>
      <main className="mx-auto max-w-[1400px] px-4 pb-16 pt-20 tablet:px-8 tablet:pt-8">{children}</main>
    </div>
  );
}
