import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { NextFunction, Request, Response } from 'express';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db/pool.js';
import { AppError } from '../http/errors.js';
import type { AgentIdentity } from '../interceptor/pipeline.js';

/**
 * Two separate trust boundaries (TRD §8):
 *   Agent  -> `Authorization: Bearer ag_...` API key, accepted ONLY by POST /api/tool-call.
 *   Admin  -> HttpOnly `ag_session` cookie, accepted ONLY by dashboard/admin endpoints.
 * Credentials of one kind are never accepted where the other is required.
 *
 * Secrets at rest: agent API keys and session tokens are high-entropy random values, so a
 * SHA-256 digest is sufficient and allows indexed lookup; admin passwords use bcrypt.
 * None of these values are ever logged or written to the audit log.
 */

export const SESSION_COOKIE = 'ag_session';
export const CSRF_HEADER = 'x-agentguard-csrf';
const AGENT_KEY_PREFIX = 'ag_';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function generateAgentApiKey(): string {
  return `${AGENT_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

// Compared against when the username does not exist, so timing does not reveal valid usernames.
const DUMMY_HASH = bcrypt.hashSync('agentguard-timing-equaliser', 12);

export interface AdminIdentity {
  id: string;
  username: string;
  sessionId: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    agent?: AgentIdentity;
    admin?: AdminIdentity;
  }
}

function bearerToken(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m ? m[1]! : null;
}

export async function findAgentByKey(db: Queryable, apiKey: string): Promise<AgentIdentity | null> {
  if (!apiKey.startsWith(AGENT_KEY_PREFIX) || apiKey.length > 200) return null;
  const r = await db.query<AgentIdentity>('SELECT id, name FROM agents WHERE api_key_hash = $1', [sha256(apiKey)]);
  return r.rows[0] ?? null;
}

/** Agent boundary. Rejects session cookies: an admin session cannot act as an agent. */
export function requireAgent(ctx: AppContext, onReject: (req: Request, reason: string) => Promise<void>) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = bearerToken(req);
      if (!token) {
        const hasSession = Boolean(req.cookies?.[SESSION_COOKIE]);
        await onReject(req, hasSession ? 'admin_session_on_agent_endpoint' : 'missing_api_key');
        throw new AppError(
          401,
          'AGENT_AUTH_REQUIRED',
          hasSession
            ? 'This endpoint accepts agent API keys only; admin sessions cannot submit tool calls.'
            : 'Missing agent API key (Authorization: Bearer <key>).',
        );
      }
      const agent = await findAgentByKey(ctx.db, token);
      if (!agent) {
        ctx.logger.warn('agent authentication failed', { ip: req.ip });
        await onReject(req, 'invalid_api_key');
        throw new AppError(401, 'INVALID_API_KEY', 'Invalid agent API key.');
      }
      req.agent = agent;
      next();
    } catch (err) {
      next(err);
    }
  };
}

export async function login(ctx: AppContext, username: string, password: string) {
  const r = await ctx.db.query<{ id: string; username: string; password_hash: string }>(
    'SELECT id, username, password_hash FROM admins WHERE username = $1',
    [username],
  );
  const admin = r.rows[0];
  const ok = await bcrypt.compare(password, admin?.password_hash ?? DUMMY_HASH);
  if (!admin || !ok) return null;
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ctx.config.sessionTtlMs);
  await ctx.db.query('INSERT INTO admin_sessions (admin_id, token_hash, expires_at) VALUES ($1, $2, $3)', [
    admin.id,
    sha256(token),
    expiresAt,
  ]);
  return { admin: { id: admin.id, username: admin.username }, token, expiresAt };
}

export async function findSession(db: Queryable, token: string): Promise<AdminIdentity | null> {
  if (token.length > 200) return null;
  const r = await db.query<{ session_id: string; id: string; username: string }>(
    `SELECT s.id AS session_id, a.id, a.username
       FROM admin_sessions s JOIN admins a ON a.id = s.admin_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [sha256(token)],
  );
  const row = r.rows[0];
  return row ? { id: row.id, username: row.username, sessionId: row.session_id } : null;
}

export async function revokeSession(db: Queryable, sessionId: string): Promise<void> {
  await db.query('UPDATE admin_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [sessionId]);
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Admin boundary. Rejects agent API keys outright (403), requires a valid, unexpired,
 * unrevoked session, and requires the CSRF header on state-changing requests. The custom
 * header cannot be set cross-site without a CORS preflight (which the API never grants),
 * and the cookie is SameSite=Strict — together these defend admin actions against CSRF.
 */
export function requireAdmin(ctx: AppContext) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const bearer = bearerToken(req);
      if (bearer?.startsWith(AGENT_KEY_PREFIX)) {
        throw new AppError(403, 'AGENT_FORBIDDEN', 'Agent API keys cannot access admin endpoints.');
      }
      const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
      if (!token) throw new AppError(401, 'UNAUTHENTICATED', 'Admin login required.');
      const admin = await findSession(ctx.db, token);
      if (!admin) throw new AppError(401, 'SESSION_INVALID', 'Your session has expired or is invalid. Log in again.');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !safeEqual(req.get(CSRF_HEADER) ?? '', '1')) {
        throw new AppError(403, 'CSRF_REJECTED', `State-changing requests must include the ${CSRF_HEADER} header.`);
      }
      req.admin = admin;
      next();
    } catch (err) {
      next(err);
    }
  };
}
