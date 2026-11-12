/**
 * AUTH MODULE: the ONLY place that knows how users are authenticated.
 * To switch to Microsoft Entra ID, replace ./devAuth.ts with an OIDC implementation
 * that provides the same three exports (getCurrentUser, mount, logout) and update the switch in
 * mountAuth() below. Nothing outside src/auth/ needs to change.
 */
import type { Express, Request, RequestHandler } from 'express';
import { getConfig, type Config } from '../config.js';
import * as devAuth from './devAuth.js';
import * as demoAuth from './demoAuth.js';
import { mountEntra, type EntraOptions } from './entra.js';
import { endSession, sessionUser } from './sessions.js';
import { adminNotices } from './notices.js';

import { ADMIN_ROLE, type AuthUser } from './types.js';
export { ADMIN_ROLE, type AuthUser };

/** The one interface the rest of the app uses to learn who is calling. */
export function getCurrentUser(req: Request): AuthUser | null {
  return getConfig().authMode === 'demo' ? demoAuth.getCurrentUser(req) : sessionUser(req);
}

export const isAdmin = (u: AuthUser): boolean => u.roles.includes(ADMIN_ROLE);

/** Mounts login/logout/session routes for the active auth mode. */
export function mountAuth(app: Express, config: Config, entraOptions: EntraOptions = {}): void {
  if (config.authMode === 'dev') {
    // Identity picker + POST /api/dev/login. Refused in production by the config guard.
    devAuth.mount(app, config);
  } else if (config.authMode === 'demo') {
    // Identity comes from the verified Cloudflare Access JWT. No picker, no /api/dev/* routes.
    demoAuth.mount(app, config);
  } else {
    // Microsoft Entra ID sign-in (/auth/login, /auth/callback, /auth/logout) + the same signed session cookie as dev.
    mountEntra(app, config, entraOptions);
    app.post('/api/logout', async (req, res) => { await endSession(req, res, config); res.status(204).end(); });
  }
  app.get('/api/session', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const user = getCurrentUser(req);
    // Operator banners (demo override active, secret about to expire) go to campaign admins only.
    res.json({ user, authMode: config.authMode, demoBanner: config.demoBanner, notices: user && user.roles?.includes(ADMIN_ROLE) ? adminNotices(config) : [] });
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
