import express, { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { AppContext } from '../context.js';
import { recordAudit, listAudit, verifyAuditLog } from '../audit/auditLog.js';
import { CSRF_HEADER, SESSION_COOKIE, login, requireAdmin, requireAgent, revokeSession } from '../auth/auth.js';
import { resolveApproval } from '../approvals/approvals.js';
import { processToolCall } from '../interceptor/pipeline.js';
import { SCENARIOS, runScenario } from '../demo/scenarios.js';
import { getCallDetail, getStats, listCalls, listPendingApprovals } from '../queries/toolCalls.js';
import { AppError, errorBody, notFound } from './errors.js';
import {
  assertJsonSafe,
  decideBody,
  listAuditQuery,
  listCallsQuery,
  loginBody,
  parse,
  statsQuery,
  toolCallBody,
  uuidParam,
} from './validation.js';
import { errorFields } from '../logger.js';

const BODY_LIMIT = '64kb';

/** Simple per-agent sliding-window cap (TRD §5: enough to keep the burst test meaningful). */
function createRateLimiter(limitPerMinute: number) {
  const hits = new Map<string, number[]>();
  return (key: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= limitPerMinute) {
      hits.set(key, recent);
      return false;
    }
    recent.push(now);
    hits.set(key, recent);
    return true;
  };
}

/** Agent-facing API: exactly one endpoint. */
export function agentRoutes(ctx: AppContext): Router {
  const router = Router();
  const allow = createRateLimiter(ctx.config.agentRateLimitPerMinute);
  const jsonParser = express.json({ limit: BODY_LIMIT, strict: true, type: () => true });

  // Every rejected request is still recorded in the audit log (FR-001, TRD §5).
  const auditRejection = async (req: Request, reason: string, details: Record<string, unknown> = {}) => {
    await recordAudit(ctx.db, {
      event_type: 'request_rejected',
      payload: {
        endpoint: 'POST /api/tool-call',
        reason,
        agent_id: req.agent?.id ?? null,
        agent_name: req.agent?.name ?? null,
        remote_addr: req.ip ?? null,
        ...details,
      },
    }).catch((err) => ctx.logger.error('failed to audit rejected request', errorFields(err)));
  };

  router.post(
    '/tool-call',
    requireAgent(ctx, (req, reason) => auditRejection(req, reason)),
    async (req, res, next) => {
      if (allow(req.agent!.id)) return next();
      await auditRejection(req, 'rate_limited');
      next(new AppError(429, 'RATE_LIMITED', `Agent exceeded ${ctx.config.agentRateLimitPerMinute} calls per minute.`));
    },
    (req: Request, res: Response, next: NextFunction) => {
      jsonParser(req, res, (err?: unknown) => {
        if (!err) return next();
        const type = (err as { type?: string }).type;
        void auditRejection(req, type === 'entity.too.large' ? 'payload_too_large' : 'malformed_json').finally(() => next(err));
      });
    },
    async (req, res) => {
      let body;
      try {
        body = parse(toolCallBody, req.body);
        assertJsonSafe(body.params);
      } catch (err) {
        await auditRejection(req, 'validation_failed', { message: (err as Error).message.slice(0, 500) });
        throw err;
      }
      const outcome = await processToolCall(ctx, {
        agent: req.agent!,
        toolName: body.tool_name,
        params: body.params,
        clientRequestedAt: body.requested_at ?? null,
        waitForApproval: body.wait_for_approval ?? false,
      });
      res.status(outcome.decision === 'pending' ? 202 : 200).json(outcome);
    },
  );
  return router;
}

/** Dashboard / admin API. Everything except login requires an admin session. */
export function adminRoutes(ctx: AppContext): Router {
  const router = Router();
  const json = express.json({ limit: BODY_LIMIT });
  const admin = requireAdmin(ctx);

  router.post('/auth/login', json, async (req, res) => {
    const body = parse(loginBody, req.body);
    const session = await login(ctx, body.username, body.password);
    if (!session) {
      ctx.logger.warn('admin login failed', { username: body.username });
      await recordAudit(ctx.db, { event_type: 'admin_login_failed', payload: { username: body.username, remote_addr: req.ip ?? null } });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect username or password.');
    }
    await recordAudit(ctx.db, { event_type: 'admin_login', payload: { admin_id: session.admin.id, username: session.admin.username } });
    res.cookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: ctx.config.cookieSecure,
      path: '/',
      expires: session.expiresAt,
    });
    res.json({ admin: { username: session.admin.username }, expires_at: session.expiresAt.toISOString(), csrf_header: CSRF_HEADER });
  });

  router.post('/auth/logout', admin, async (req, res) => {
    await revokeSession(ctx.db, req.admin!.sessionId);
    await recordAudit(ctx.db, { event_type: 'admin_logout', payload: { admin_id: req.admin!.id, username: req.admin!.username } });
    res.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'strict', secure: ctx.config.cookieSecure });
    res.json({ ok: true });
  });

  router.get('/auth/session', admin, (req, res) => {
    res.json({ admin: { username: req.admin!.username } });
  });

  router.get('/tool-calls', admin, async (req, res) => {
    const q = parse(listCallsQuery, req.query);
    res.json(
      await listCalls(ctx.db, {
        status: q.status,
        dateFrom: q.date_from ? new Date(q.date_from) : undefined,
        dateTo: q.date_to ? new Date(q.date_to) : undefined,
        page: q.page,
        pageSize: q.page_size,
      }),
    );
  });

  router.get('/tool-calls/:id', admin, async (req, res) => {
    const id = parse(uuidParam, req.params.id);
    const detail = await getCallDetail(ctx.db, id, ctx.config.approvalTimeoutMs);
    if (!detail) throw notFound('Call not found.');
    res.json(detail);
  });

  router.get('/approvals/pending', admin, async (_req, res) => {
    const items = await listPendingApprovals(ctx.db, ctx.config.approvalTimeoutMs);
    res.json({ items, timeout_seconds: ctx.config.approvalTimeoutMs / 1000 });
  });

  router.post('/approvals/:id/decide', admin, json, async (req, res) => {
    const id = parse(uuidParam, req.params.id);
    const body = parse(decideBody, req.body);
    const result = await resolveApproval(ctx, id, body.decision, { id: req.admin!.id, username: req.admin!.username });
    res.json(result);
  });

  router.get('/audit-log', admin, async (req, res) => {
    const q = parse(listAuditQuery, req.query);
    res.json(await listAudit(ctx.db, { page: q.page, pageSize: q.page_size, eventType: q.event_type, callId: q.call_id, focusSeq: q.focus_seq }));
  });

  router.get('/audit-log/verify', admin, async (_req, res) => {
    try {
      const result = await verifyAuditLog(ctx.db);
      if (!result.valid) ctx.logger.warn('audit log verification FAILED', { broken_seq: result.broken_seq, reason: result.reason });
      res.json(result);
    } catch (err) {
      // "Could not run the check" must be distinguishable from "chain is tampered" (TRD §6).
      ctx.logger.error('audit verification could not run', errorFields(err));
      res.status(500).json(errorBody('VERIFY_FAILED_TO_RUN', 'The integrity check could not run (database unavailable?). This is not a tamper result.'));
    }
  });

  router.get('/stats', admin, async (req, res) => {
    const q = parse(statsQuery, req.query);
    res.json(await getStats(ctx.db, q.range, ctx.config.businessHours.timeZone));
  });

  router.get('/demo/scenarios', admin, (_req, res) => {
    res.json({
      items: Object.values(SCENARIOS).map(({ name, title, description, expected }) => ({ name, title, description, expected })),
    });
  });

  router.post('/demo/trigger/:scenario', admin, async (req, res) => {
    res.json(await runScenario(ctx, String(req.params.scenario), req.admin!.username));
  });

  // Live updates over Server-Sent Events (FR-016). 503 => the dashboard polls instead.
  router.get('/events', admin, (req, res) => {
    const feed = ctx.changeFeed;
    if (!feed?.healthy) {
      res.status(503).json(errorBody('REALTIME_UNAVAILABLE', 'Live channel unavailable; poll instead.'));
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\nevent: ready\ndata: {}\n\n');
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    const unsubscribe = feed.subscribe(
      (e) => res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`),
      () => res.end(),
    );
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  return router;
}
