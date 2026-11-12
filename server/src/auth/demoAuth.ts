import crypto from 'node:crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import type { Config, DemoProfile } from '../config.js';
import { getPool } from '../db.js';
import { ensureDemoSession } from './sessions.js';
import type { AuthUser } from './types.js';

/**
 * AUTH_MODE=demo: the user IS the email in the Cloudflare Access JWT that auth/access.ts has already verified
 * (res.locals.accessEmail). There is no app login and no session cookie: nothing the request body, query string or
 * any other header says about identity is ever read. Profiles (name, roles, employee code) come from the
 * DEMO_USERS secret; an allowed email that is not listed is plain staff with no employee code (-> "sign up" card).
 */
const NAMESPACE = '6f1c1f0e-5a53-4d56-9a5b-3d1d6f0b7a11';   // fixed namespace for the demo's v5 UUIDs

/** RFC 4122 UUID v5 (SHA-1). Same input -> same id on every login, every restart, every deploy. */
export function uuidv5(name: string, namespace: string = NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const h = crypto.createHash('sha1').update(ns).update(name, 'utf8').digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

const titleCase = (s: string) => s.split(/[\s._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/** Pure: the profile for a verified email. Unmapped -> plain staff, no code. */
export function demoUserFor(email: string, profiles: Record<string, DemoProfile>): AuthUser {
  const e = email.trim().toLowerCase();
  const p = profiles[e];
  return {
    oid: uuidv5(e), email: e,
    displayName: p?.displayName ?? (titleCase(e.split('@')[0]) || e),
    roles: p?.roles ?? [],
    employeeCode: p?.employeeCode ?? null,
  };
}

/** Create or update the users row. Unchanged rows are not rewritten (the WHERE makes the conflict branch a no-op). */
async function syncUser(u: AuthUser): Promise<void> {
  await getPool().query(
    `INSERT INTO users (entra_oid, email, display_name, employee_code) VALUES ($1, $2, $3, $4)
     ON CONFLICT (entra_oid) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, employee_code = EXCLUDED.employee_code
     WHERE (users.email, users.display_name, users.employee_code) IS DISTINCT FROM (EXCLUDED.email, EXCLUDED.display_name, EXCLUDED.employee_code)`,
    [u.oid, u.email, u.displayName, u.employeeCode]);
}

type WithDemoUser = Request & { demoUser?: AuthUser };

export function getCurrentUser(req: Request): AuthUser | null {
  return (req as WithDemoUser).demoUser ?? null;
}

export function mount(app: Express, config: Config): void {
  // Runs after the Access gate (app.ts mounts the gate first), for API calls only.
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    const email = res.locals.accessEmail as string | null | undefined;
    if (!email) { next(); return; }   // identity-less token (e.g. a service token): signed out, protected routes answer 401
    const user = demoUserFor(email, config.demoUsers);
    syncUser(user).then(() => ensureDemoSession(req, config, user)).then(() => { (req as WithDemoUser).demoUser = user; next(); }, next);
  });
  // Access owns sign-out (/cdn-cgi/access/logout); the app has no session to clear.
  app.post('/api/logout', (_req, res) => { res.status(204).end(); });
}
