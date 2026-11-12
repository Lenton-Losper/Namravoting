import crypto from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { Config } from '../config.js';
import { getPool } from '../db.js';
import { cookieOptions, readCookie } from './cookies.js';
import { signingKey, verifyKeys } from './keys.js';
import { signValue, verifyValue } from './signing.js';
import { ADMIN_ROLE, type AuthUser } from './types.js';

/**
 * Server-side sessions (SEC-06). The cookie is `<random id>.<mac>`; the database row is keyed by SHA-256(id).
 * - logout revokes the row, so a copied cookie stops working at once;
 * - a new random id is issued at every sign-in (no fixation), and any session cookie the browser still held is revoked;
 * - sliding: every request extends the session by its idle timeout (admins 4h, staff 8h), never past an absolute maximum of 12h
 *   after sign-in; `expires_at` is the idle deadline, `created_at + 12h` the absolute one;
 * - roles are recomputed from live configuration and data on every request.
 */
export const SESSION_COOKIE = 'namra_session';
export const STAFF_TTL_SECONDS = 8 * 3600;
export const ADMIN_TTL_SECONDS = 4 * 3600;
export const ABSOLUTE_MAX_SECONDS = 12 * 3600;
/** Extending is a write, so a session is only touched when its deadline is at least this far behind. */
const EXTEND_AFTER_SECONDS = 60;
const MAX_SESSIONS_PER_USER = 10;

const hashId = (id: string) => crypto.createHash('sha256').update(id).digest('hex');

type WithSession = Request & { sessionUser?: AuthUser | null; sessionIdHash?: string | null; sessionId?: string | null };

/** The signed-in user for this request (set by sessionLoader), or null. */
export const sessionUser = (req: Request): AuthUser | null => (req as WithSession).sessionUser ?? null;
/**
 * The raw session id of this request. The database functions that delete or reset a campaign take it instead of an actor id and
 * look up whose live session it is (migration 011), so the actor is never something the caller can simply claim.
 */
export const sessionRawId = (req: Request): string | null => (req as WithSession).sessionId ?? null;
/** Hash of this request's session id: the identity a CSRF token can be bound to. */
export const sessionKeyOf = (req: Request): string | null => (req as WithSession).sessionIdHash ?? null;

/** Roles for an account: the IdP's app role, or (entra mode) the account id in ADMIN_OIDS, or the email fallback. */
export function rolesFor(config: Config, a: { claimAdmin: boolean; oid: string; email: string }): string[] {
  const e = config.entra;
  const admin = a.claimAdmin
    || (!!e && (e.adminOids.includes(a.oid.toLowerCase()) || (e.adminEmailsAllowed && e.adminEmails.includes(a.email.toLowerCase()))));
  return admin ? [ADMIN_ROLE] : [];
}

/** Loads the session behind the cookie (if any) into req. Mount on /api and /auth. Never throws for a bad cookie. */
export function sessionLoader(config: Config): RequestHandler {
  return async (req, _res, next) => {
    const w = req as WithSession;
    w.sessionUser = null; w.sessionIdHash = null; w.sessionId = null;
    try {
      const raw = readCookie(req, SESSION_COOKIE);
      const id = raw ? verifyValue(verifyKeys(config, 'session'), raw) : null;
      if (id) {
        const h = hashId(id);
        const { rows } = await getPool().query(
          `SELECT s.claim_admin, u.entra_oid, u.email, u.display_name, u.employee_code
             FROM sessions s JOIN users u ON u.entra_oid = s.user_oid
            WHERE s.id_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()
              AND s.created_at + make_interval(secs => $2) > now()`, [h, ABSOLUTE_MAX_SECONDS]);
        const r = rows[0];
        if (r) {
          w.sessionIdHash = h; w.sessionId = id;
          w.sessionUser = {
            oid: r.entra_oid, email: r.email, displayName: r.display_name, employeeCode: r.employee_code ?? null,
            roles: rolesFor(config, { claimAdmin: r.claim_admin, oid: r.entra_oid, email: r.email }),
          };
          const idle = w.sessionUser.roles.includes(ADMIN_ROLE) ? ADMIN_TTL_SECONDS : STAFF_TTL_SECONDS;
          await getPool().query(
            `UPDATE sessions SET expires_at = LEAST(now() + make_interval(secs => $2), created_at + make_interval(secs => $3))
              WHERE id_hash = $1 AND expires_at < LEAST(now() + make_interval(secs => $2), created_at + make_interval(secs => $3)) - make_interval(secs => $4)`,
            [h, idle, ABSOLUTE_MAX_SECONDS, EXTEND_AFTER_SECONDS]);
        }
      }
    } catch (e) { next(e); return; }
    next();
  };
}

/** Creates a session for an account (its users row must exist), sets the cookie, revokes the one the browser came with. */
export async function createSession(req: Request, res: Response, config: Config, a: { oid: string; email: string; claimAdmin: boolean }): Promise<void> {
  const pool = getPool();
  const old = (req as WithSession).sessionIdHash;
  if (old) await pool.query('UPDATE sessions SET revoked_at = now() WHERE id_hash = $1 AND revoked_at IS NULL', [old]);
  const isAdmin = rolesFor(config, a).length > 0;
  const ttl = isAdmin ? ADMIN_TTL_SECONDS : STAFF_TTL_SECONDS;
  const id = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO sessions (id_hash, user_oid, claim_admin, expires_at) VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [hashId(id), a.oid, a.claimAdmin, ttl]);
  // housekeeping: expired/revoked rows, and only the newest few sessions per account
  await pool.query(`DELETE FROM sessions WHERE (expires_at < now() - interval '1 day') OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '1 day')`);
  await pool.query(
    `DELETE FROM sessions WHERE user_oid = $1 AND id_hash NOT IN (SELECT id_hash FROM sessions WHERE user_oid = $1 ORDER BY created_at DESC LIMIT $2)`,
    [a.oid, MAX_SESSIONS_PER_USER]);
  res.cookie(SESSION_COOKIE, signValue(signingKey(config, 'session'), id), cookieOptions(config, { httpOnly: true, maxAge: ABSOLUTE_MAX_SECONDS * 1000 }));
}

/** Logout: revokes the session row (so a copied cookie is dead too) and clears the cookie. */
export async function endSession(req: Request, res: Response, config: Config): Promise<void> {
  const h = (req as WithSession).sessionIdHash;
  if (h) await getPool().query('UPDATE sessions SET revoked_at = now() WHERE id_hash = $1 AND revoked_at IS NULL', [h]);
  res.clearCookie(SESSION_COOKIE, cookieOptions(config, { httpOnly: true }));
}

/** Sign out everywhere (all sessions of one account), e.g. when someone leaves or is demoted. */
export async function revokeAllSessions(oid: string): Promise<number> {
  return (await getPool().query('UPDATE sessions SET revoked_at = now() WHERE user_oid = $1 AND revoked_at IS NULL', [oid])).rowCount ?? 0;
}

/**
 * AUTH_MODE=demo has no login and no cookie (the Cloudflare Access JWT is the identity), but the database functions still want a
 * live session. So each verified demo identity gets one deterministic session row: its id is an HMAC of the account id under the
 * session key, so it cannot be guessed, and it is refreshed on use.
 */
export async function ensureDemoSession(req: Request, config: Config, u: { oid: string; roles: string[] }): Promise<void> {
  const id = crypto.createHmac('sha256', signingKey(config, 'session')).update('demo-session:' + u.oid).digest('base64url');
  await getPool().query(
    `INSERT INTO sessions (id_hash, user_oid, claim_admin, expires_at) VALUES ($1, $2, $3, now() + interval '12 hours')
     ON CONFLICT (id_hash) DO UPDATE SET expires_at = now() + interval '12 hours', revoked_at = NULL, claim_admin = EXCLUDED.claim_admin`,
    [hashId(id), u.oid, u.roles.includes(ADMIN_ROLE)]);
  (req as WithSession).sessionId = id;
}
