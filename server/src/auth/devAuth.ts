import crypto from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import type { Config } from '../config.js';
import { getPool, UNIQUE_VIOLATION } from '../db.js';
import { HttpError } from '../errors.js';
import { ADMIN_ROLE, type AuthUser } from './types.js';
import { DEV_USERS } from './devUsers.js';
import { cookieOptions, readCookie } from './cookies.js';
import { sign, verify } from './signing.js';
import { getConfig } from '../config.js';
import { normalizeEmployeeCode } from '../domain/employeeCode.js';

const COOKIE = 'namra_session';
const TTL_MS = 8 * 60 * 60 * 1000;

interface SessionPayload extends AuthUser { exp: number }

/** Reads the signed, HttpOnly session cookie. Returns null if absent, tampered or expired. */
export function getCurrentUser(req: Request): AuthUser | null {
  const raw = readCookie(req, COOKIE);
  if (!raw) return null;
  const p = verify<SessionPayload>(getConfig().sessionSecret, raw);
  if (!p || typeof p.exp !== 'number' || p.exp < Date.now()) return null;
  return { oid: p.oid, email: p.email, displayName: p.displayName, roles: p.roles, employeeCode: p.employeeCode ?? null };
}

export function setSession(res: Response, config: Config, user: AuthUser): void {
  const payload: SessionPayload = { ...user, exp: Date.now() + TTL_MS };
  res.cookie(COOKIE, sign(config.sessionSecret, payload), cookieOptions(config, { httpOnly: true, maxAge: TTL_MS }));
}

export function clearSession(res: Response, config: Config): void {
  res.clearCookie(COOKIE, cookieOptions(config, { httpOnly: true }));
}

const loginBody = z.object({
  oid: z.string().uuid(),
  email: z.string().email().max(254),
  displayName: z.string().trim().min(1).max(120),
  roles: z.array(z.enum([ADMIN_ROLE])).max(1),
  // Dev stub only: the identity picker plays the identity provider, so it "asserts" the code (Entra: employeeId).
  employeeCode: z.string().max(32).nullable().optional(),
}).strict();

export function mount(app: Express, config: Config): void {
  // Dev-only identity picker. Only mounted when AUTH_MODE=dev (config refuses dev+production).
  app.get('/api/dev/users', (_req, res) => { res.json({ users: DEV_USERS }); });

  app.post('/api/dev/login', async (req, res) => {
    const b = loginBody.parse(req.body);
    const employeeCode = normalizeEmployeeCode(b.employeeCode);   // malformed -> null
    try {
      await getPool().query(
        `INSERT INTO users (entra_oid, email, display_name, employee_code) VALUES ($1, $2, $3, $4)
         ON CONFLICT (entra_oid) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, employee_code = EXCLUDED.employee_code`,
        [b.oid, b.email.toLowerCase(), b.displayName, employeeCode],
      );
    } catch (e) {
      if ((e as { code?: string }).code === UNIQUE_VIOLATION) throw new HttpError(409, 'Email already belongs to another user');
      throw e;
    }
    const user: AuthUser = { oid: b.oid, email: b.email.toLowerCase(), displayName: b.displayName, roles: b.roles, employeeCode };
    setSession(res, config, user);
    res.json({ user });
  });

  app.post('/api/logout', (_req, res) => {
    clearSession(res, config);
    res.status(204).end();
  });
}

/** Exported for tests only. */
export const _internal = { COOKIE, randomId: () => crypto.randomUUID() };
