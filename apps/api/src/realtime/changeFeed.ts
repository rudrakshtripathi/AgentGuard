import { EventEmitter } from 'node:events';
import pg from 'pg';
import type { Logger } from '../logger.js';

/**
 * Live-update channel (FR-016). One dedicated connection LISTENs on 'agentguard_changes'
 * (fed by the NOTIFY triggers in db/migrations/002) and fans events out to subscribers —
 * the SSE endpoint relays them to authenticated dashboard sessions.
 *
 * If the connection drops, `healthy` flips to false, subscribers are told (so the dashboard
 * switches to polling instead of silently freezing), and we reconnect with backoff.
 * Note: requires a session-mode connection (Supabase's transaction pooler cannot LISTEN).
 */

export interface ChangeEvent {
  table: string;
  op: string;
  id: string;
  tool_call_id: string | null;
}

export interface ChangeFeed {
  readonly healthy: boolean;
  subscribe(onEvent: (e: ChangeEvent) => void, onDown: () => void): () => void;
  close(): Promise<void>;
}

export function createChangeFeed(connectionString: string, logger: Logger): ChangeFeed {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  let client: pg.Client | null = null;
  let healthy = false;
  let closed = false;
  let backoff = 500;
  let timer: NodeJS.Timeout | null = null;

  const markDown = (why: string) => {
    if (healthy) logger.warn('realtime channel down — dashboards fall back to polling', { reason: why });
    healthy = false;
    emitter.emit('down');
    client?.removeAllListeners();
    client?.end().catch(() => {});
    client = null;
    if (!closed && !timer) {
      timer = setTimeout(() => {
        timer = null;
        void connect();
      }, backoff);
      backoff = Math.min(backoff * 2, 10_000);
    }
  };

  const connect = async () => {
    const c = new pg.Client({ connectionString });
    client = c;
    c.on('error', (err) => markDown(err.message));
    c.on('end', () => markDown('connection ended'));
    c.on('notification', (msg) => {
      if (msg.channel !== 'agentguard_changes' || !msg.payload) return;
      try {
        emitter.emit('change', JSON.parse(msg.payload) as ChangeEvent);
      } catch {
        /* ignore malformed payloads */
      }
    });
    try {
      await c.connect();
      await c.query('LISTEN agentguard_changes');
      healthy = true;
      backoff = 500;
      logger.info('realtime channel listening');
    } catch (err) {
      markDown((err as Error).message);
    }
  };

  void connect();

  return {
    get healthy() {
      return healthy;
    },
    subscribe(onEvent, onDown) {
      emitter.on('change', onEvent);
      emitter.on('down', onDown);
      return () => {
        emitter.off('change', onEvent);
        emitter.off('down', onDown);
      };
    },
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      healthy = false;
      const c = client;
      client = null;
      c?.removeAllListeners();
      await c?.end().catch(() => {});
    },
  };
}
