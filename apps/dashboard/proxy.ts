import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * Login gate (FR-018). Every page except /login requires an admin session, and the session
 * is validated SERVER-SIDE against the API (not just "a cookie exists"). Unauthenticated
 * visitors are redirected to /login?next=<original path> so they land back after login.
 * The data APIs enforce the same check independently, so nothing leaks if this is bypassed.
 */
const API_URL = (process.env.API_URL ?? 'http://127.0.0.1:4000').replace(/\/$/, '');

async function sessionValid(req: NextRequest): Promise<boolean | null> {
  const cookie = req.cookies.get('ag_session');
  if (!cookie) return false;
  try {
    const res = await fetch(`${API_URL}/api/auth/session`, {
      headers: { cookie: `ag_session=${cookie.value}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return null; // API unreachable: let the page render its own error state
  }
}

export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const valid = await sessionValid(req);
  if (pathname === '/login') {
    if (valid === true) return NextResponse.redirect(new URL('/', req.url));
    return NextResponse.next();
  }
  if (valid === false) {
    const login = new URL('/login', req.url);
    login.searchParams.set('next', pathname + search);
    const res = NextResponse.redirect(login);
    if (req.cookies.get('ag_session')) res.cookies.delete('ag_session');
    return res;
  }
  return NextResponse.next();
}

export const config = {
  // Pages only: never the proxied /api/*, Next internals, or static files.
  matcher: ['/((?!api/|_next/|favicon.ico|.*\\.(?:svg|png|ico|woff2?)$).*)'],
};
