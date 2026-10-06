'use client';

import { LiveProvider } from '@/lib/live';
import { Shell } from '@/components/Shell';
import { ToastProvider } from '@/components/Toast';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <LiveProvider>
      <ToastProvider>
        <Shell>{children}</Shell>
      </ToastProvider>
    </LiveProvider>
  );
}
