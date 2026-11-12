import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import multer from 'multer';
import { routeLabel, scrub } from './logSafe.js';

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
export const notFound = () => new HttpError(404, 'Not found');

export const notFoundHandler: RequestHandler = (_req, res) => { res.status(404).json({ error: 'Not found' }); };

/** Central error handler: never leaks stack traces or internals. */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (err instanceof HttpError) { res.status(err.status).json({ error: err.message, code: err.code }); return; }
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Invalid request', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    return;
  }
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === 'LIMIT_FILE_SIZE';
    res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'File too large (max 2 MB)' : 'Invalid upload' });
    return;
  }
  if ((err as { type?: string }).type === 'entity.parse.failed') { res.status(400).json({ error: 'Malformed JSON' }); return; }
  // Log only method + route pattern + a scrubbed message. Never request bodies (vote routes must not leak ballots), never the
  // share token that is part of the URL (SEC-19).
  console.error(`[error] ${req.method} ${routeLabel(req)}: ${scrub(String((err as Error)?.message ?? 'unknown')).slice(0, 300)}`);
  res.status(500).json({ error: 'Internal server error' });
};
