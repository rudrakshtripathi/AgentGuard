'use client';

import { createContext, useCallback, useContext, useState } from 'react';
import { CheckIcon, XIcon } from './icons';

/** Success toasts auto-dismiss after 4s; failure toasts persist until dismissed (spec §3). */
interface Toast {
  id: number;
  tone: 'success' | 'error';
  message: string;
}
const ToastContext = createContext<(tone: Toast['tone'], message: string) => void>(() => {});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (tone: Toast['tone'], message: string) => {
      const id = Date.now() + Math.random();
      setToasts((ts) => [...ts, { id, tone, message }]);
      if (tone === 'success') setTimeout(() => dismiss(id), 4000);
    },
    [dismiss],
  );
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            aria-live={t.tone === 'error' ? 'assertive' : 'polite'}
            className={`flex items-start gap-3 rounded-md border bg-raised px-4 py-3 shadow-[var(--shadow-2)] ${t.tone === 'error' ? 'border-error' : 'border-success'}`}
          >
            <span className={t.tone === 'error' ? 'text-error' : 'text-success'}>{t.tone === 'error' ? <XIcon /> : <CheckIcon />}</span>
            <p className="flex-1">{t.message}</p>
            <button type="button" onClick={() => dismiss(t.id)} className="text-muted hover:text-text" aria-label="Dismiss notification">
              <XIcon />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
