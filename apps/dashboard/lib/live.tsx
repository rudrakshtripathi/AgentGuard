'use client';

import { createContext, useCallback, useContext, useEffect, useEffectEvent, useRef, useState } from 'react';

/**
 * Live updates (FR-016). Primary channel: Server-Sent Events from the API (/api/events),
 * which relays Postgres NOTIFY events. If that channel is unavailable or drops, the
 * dashboard switches to polling every 2.5s and shows it — it never silently freezes.
 * It keeps trying to re-establish the live channel in the background.
 */
export type LiveMode = 'connecting' | 'live' | 'polling';

export const POLL_INTERVAL_MS = 2500;
const RECONNECT_MS = 8000;

interface LiveContextValue {
  mode: LiveMode;
  /** Increments whenever data may have changed (live event or poll tick). */
  version: number;
}

const LiveContext = createContext<LiveContextValue>({ mode: 'connecting', version: 0 });

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<LiveMode>('connecting');
  const [version, setVersion] = useState(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bump = useCallback(() => {
    if (debounce.current) return;
    debounce.current = setTimeout(() => {
      debounce.current = null;
      setVersion((v) => v + 1);
    }, 200);
  }, []);

  useEffect(() => {
    let source: EventSource | null = null;
    let reconnect: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      if (closed) return;
      source = new EventSource('/api/events');
      source.addEventListener('ready', () => {
        setMode('live');
        bump(); // catch up on anything missed while polling
      });
      source.addEventListener('change', bump);
      source.onerror = () => {
        source?.close();
        source = null;
        setMode('polling');
        if (!closed && !reconnect) {
          reconnect = setTimeout(() => {
            reconnect = null;
            connect();
          }, RECONNECT_MS);
        }
      };
    };
    connect();
    return () => {
      closed = true;
      source?.close();
      if (reconnect) clearTimeout(reconnect);
    };
  }, [bump]);

  useEffect(() => {
    if (mode !== 'polling') return;
    const t = setInterval(() => setVersion((v) => v + 1), POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [mode]);

  return <LiveContext.Provider value={{ mode, version }}>{children}</LiveContext.Provider>;
}

export function useLive() {
  return useContext(LiveContext);
}

/**
 * Fetches data and refetches whenever live data changes. On a refresh failure the
 * last good data stays visible alongside the error (spec §3 Table error state).
 */
export function useLiveData<T>(fetcher: () => Promise<T>, key = '') {
  const { version } = useLive();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [manual, setManual] = useState(0);
  const load = useEffectEvent(() => fetcher());

  useEffect(() => {
    let cancelled = false;
    load()
      .then((d) => {
        if (cancelled) return;
        setData(d);
        setError(null);
      })
      .catch((e: Error) => !cancelled && setError(e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [version, manual, key]);

  const refresh = useCallback(() => setManual((m) => m + 1), []);
  return { data, error, loading, refresh };
}
