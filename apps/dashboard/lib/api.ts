/** Thin REST client for the AgentGuard API (same-origin, proxied by Next rewrites). */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

function redirectToLogin() {
  if (typeof window === 'undefined' || window.location.pathname === '/login') return;
  const next = window.location.pathname + window.location.search;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        // CSRF defence for state-changing requests (see API auth.ts).
        ...(method !== 'GET' ? { 'x-agentguard-csrf': '1' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'NETWORK', "Couldn't reach the server. Check your connection and try again.");
  }
  const body = (await res.json().catch(() => null)) as { error?: { code: string; message: string; details?: Record<string, unknown> } } | null;
  if (!res.ok) {
    const code = body?.error?.code ?? `HTTP_${res.status}`;
    if (res.status === 401 && path !== '/api/auth/login') redirectToLogin();
    const fallback = res.status >= 500 ? 'The server ran into a problem. Try again in a moment.' : `Request failed (HTTP ${res.status}).`;
    throw new ApiError(res.status, code, body?.error?.message ?? fallback, body?.error?.details);
  }
  return body as T;
}
