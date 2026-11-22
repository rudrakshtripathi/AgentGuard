import express from 'express';
import cookieParser from 'cookie-parser';
import type { AppContext } from './context.js';
import { adminRoutes, agentRoutes } from './http/routes.js';
import { errorHandler, notFoundHandler } from './http/errors.js';
import { timingSafeEqual } from 'node:crypto';
import { metricsRegistry, pendingApprovals } from './metrics.js';

export function createApp(ctx: AppContext): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', ctx.config.trustProxyHops ?? 'loopback');
  app.set('etag', false);

  app.use((req, res, next) => {
    res.set({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    });
    if (req.path !== '/health') ctx.logger.debug('request', { method: req.method, path: req.path });
    next();
  });
  app.use(cookieParser());

  if (ctx.config.metricsToken) {
    app.get('/metrics', async (req, res, next) => {
      const header = req.get('authorization') ?? '';
      const supplied = header.startsWith('Bearer ') ? Buffer.from(header.slice(7)) : Buffer.alloc(0);
      const expected = Buffer.from(ctx.config.metricsToken!);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        res.status(401).set('www-authenticate', 'Bearer').send('Unauthorized');
        return;
      }
      try {
        const result = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM approvals WHERE status = 'pending'");
        pendingApprovals.set(result.rows[0]!.n);
        res.set('content-type', metricsRegistry.contentType).send(await metricsRegistry.metrics());
      } catch (err) {
        next(err);
      }
    });
  }

  // Public health check (TRD §13). Reports dependency status only — never secrets.
  app.get('/health', async (_req, res) => {
    const [database, opa] = await Promise.all([
      ctx.db.query('SELECT 1').then(
        () => true,
        () => false,
      ),
      ctx.policy.health(),
    ]);
    const checks = {
      database,
      opa,
      classifier: ctx.classifier !== null,
      realtime: ctx.changeFeed?.healthy ?? false,
    };
    const ok = checks.database && checks.opa && checks.classifier;
    res.status(ok ? 200 : 503).json({
      status: ok ? 'ok' : 'degraded',
      checks,
      ...(ctx.classifierError ? { classifier_error: ctx.classifierError } : {}),
    });
  });

  app.use('/api', agentRoutes(ctx));
  app.use('/api', adminRoutes(ctx));
  app.use(notFoundHandler);
  app.use(errorHandler(ctx.logger));
  return app;
}
