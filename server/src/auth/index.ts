/**
 * AUTH MODULE: the ONLY place that knows how users are authenticated.
 * To switch to Microsoft Entra ID, replace ./devAuth.ts with an OIDC implementation
 * that provides the same three exports (getCurrentUser, mount, logout) and update the switch in
 * mountAuth() below. Nothing outside src/auth/ needs to change.
 */
import type { Express, Request, RequestHandler } from 'express';
import type { Config } from '../config.js';
import * as devAuth from './devAuth.js';

import { ADMIN_ROLE, type AuthUser } from './types.js';
export { ADMIN_ROLE, type AuthUser };

/** The one interface the rest of the app uses to learn who is calling. */
export function getCurrentUser(req: Request): AuthUser | null {
  return devAuth.getCurrentUser(req);
}

export const isAdmin = (u: AuthUser): boolean => u.roles.includes(ADMIN_ROLE);

/** Mounts login/logout/session routes for the active auth mode. */
export function mountAuth(app: Express, config: Config): void {
  if (config.authMode === 'dev') {
    devAuth.mount(app, config);   // includes POST /api/dev/login (dev only)
  } else {
    throw new Error('AUTH_MODE=entra is not implemented yet (see README: "Swapping in Entra ID")');
  }
  app.get('/api/session', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ user: getCurrentUser(req), authMode: config.authMode });
  });
}

export const requireUser: RequestHandler = (req, res, next) => {
  if (!getCurrentUser(req)) { res.status(401).json({ error: 'Not signed in' }); return; }
  next();
};

/** Convenience for handlers that run after requireUser. */
export function currentUser(req: Request): AuthUser {
  const u = getCurrentUser(req);
  if (!u) throw new Error('currentUser() called without requireUser');
  return u;
}
