import crypto from 'node:crypto';
import type { Request } from 'express';

/**
 * SEC-19: log lines carry no share token, no session id and no voter account id.
 *  - a request is named by its route pattern ("/api/vote/:shareToken"), never by the URL that was actually called;
 *  - an account is named by a short one-way tag, enough to match two log lines of the same account and for an admin who knows
 *    the account id to recognise it (idTag), not to read it back;
 *  - anything token-shaped inside a message is masked.
 */
const UUID_SRC = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_ONLY = new RegExp('^' + UUID_SRC + '$', 'i');   // no g flag: a global regex keeps state between .test() calls
const TOKENISH = /[A-Za-z0-9_-]{32,}/g;

export const idTag = (id: string): string => crypto.createHash('sha256').update('namra-log:' + id).digest('hex').slice(0, 10);

export function scrub(text: string): string {
  return text.replace(new RegExp(UUID_SRC, 'gi'), '[id]').replace(TOKENISH, '[token]');
}

/**
 * "/api/vote/:shareToken": the URL that was called with every route parameter replaced by its name. (When an error is handled,
 * Express has already forgotten the router's base path, so the label is rebuilt from the original URL.) Anything long or
 * uuid-like that is left over is masked too.
 */
export function routeLabel(req: Pick<Request, 'path' | 'originalUrl'> & { params?: object }): string {
  let path = (req.originalUrl ?? req.path ?? '').split('?')[0];
  for (const [name, value] of Object.entries((req.params ?? {}) as Record<string, unknown>)) {
    if (typeof value === 'string' && value.length > 0) path = path.split('/').map((seg) => (seg === value || seg === encodeURIComponent(value) ? ':' + name : seg)).join('/');
  }
  return path.split('/').map((seg) => (UUID_ONLY.test(seg) || /^[A-Za-z0-9_-]{24,}$/.test(seg) ? ':id' : seg)).join('/');
}
