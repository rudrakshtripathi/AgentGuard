import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from '../logger.js';
import { errorFields } from '../logger.js';

/** Error with an HTTP status and a stable, machine-readable code (TRD §5). */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new AppError(400, 'INVALID_REQUEST', message, details);
export const notFound = (message: string) => new AppError(404, 'NOT_FOUND', message);

export interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

export function errorBody(code: string, message: string, details?: Record<string, unknown>): ErrorBody {
  return { error: details ? { code, message, details } : { code, message } };
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json(errorBody('NOT_FOUND', `No route for ${req.method} ${req.path}`));
};

/** Central error handler: structured JSON, never a stack trace (TRD §5, §9). */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (err instanceof AppError) {
      res.status(err.status).json(errorBody(err.code, err.message, err.details));
      return;
    }
    // body-parser errors carry a `type` and `status`.
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json(errorBody('MALFORMED_JSON', 'Request body is not valid JSON.'));
      return;
    }
    if (e?.type === 'entity.too.large') {
      res.status(413).json(errorBody('PAYLOAD_TOO_LARGE', 'Request body exceeds the 64KB limit.'));
      return;
    }
    if (e?.status === 415 || e?.type === 'charset.unsupported' || e?.type === 'encoding.unsupported') {
      res.status(415).json(errorBody('UNSUPPORTED_MEDIA_TYPE', 'Request body encoding is not supported.'));
      return;
    }
    logger.error('unhandled error', { method: req.method, path: req.path, ...errorFields(err) });
    if (res.headersSent) return;
    res.status(500).json(errorBody('INTERNAL_ERROR', 'An unexpected error occurred. Check the server logs.'));
  };
}
