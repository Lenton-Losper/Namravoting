import type { Express, Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import type { Config } from '../config.js';
import { getPool } from '../db.js';
import { HttpError } from '../errors.js';
import { audit } from '../services/audit.js';
import { bindMemberByEmail } from '../services/umoja.js';
import { demoUserFor } from './demoAuth.js';
import { clientIp } from './limits.js';
import { createSession, endSession } from './sessions.js';
import { ADMIN_ROLE } from './types.js';

/**
 * AUTH_MODE=email-demo: DEMO ONLY. The person types an email address and is signed in as that address. No code is sent, so this
 * proves nothing about who is at the keyboard: anyone who knows a NamRA address can sign in as it. That is why:
 *   - it refuses to start in production unless DEMO=true (config.ts), and the login page says "Demo sign-in";
 *   - only addresses ending @namra.org.na, plus the ones listed in DEMO_USERS, are accepted;
 *   - there is NO password, not even for the admin accounts (DEMO_USERS entries with CampaignAdmin): anyone who types an admin's
 *     address is that admin. Acceptable for a demo with test data only;
 *   - sign-ins are rate limited per client address, and every sign-in is in the audit log with its email.
 * Sessions are the ordinary server-side sessions (auth/sessions.ts). An address that already has an account keeps that account id
 * (so an Entra account keeps its campaigns); a new address gets the same deterministic v5 id as AUTH_MODE=demo.
 */
export const EMAIL_DEMO_DOMAIN = 'namra.org.na';

const body = z.object({
  email: z.string().max(254),
}).strict();

const normal = (e: string) => e.trim().toLowerCase();
const looksLikeEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/** Whether an address may sign in at all: any @namra.org.na address, or one listed in DEMO_USERS or ADMIN_EMAILS. */
export function emailAllowed(email: string, config: Pick<Config, 'demoUsers'> & { demoAdminEmails?: string[] }): boolean {
  return email.endsWith(`@${EMAIL_DEMO_DOMAIN}`) || Object.prototype.hasOwnProperty.call(config.demoUsers, email) || (config.demoAdminEmails ?? []).includes(email);
}

export function mount(app: Express, config: Config): void {
  const limiter = rateLimit({
    windowMs: 60_000, limit: Math.min(10, config.authRateLimit), standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(clientIp(req as Request)),
    message: { error: 'Too many sign-in attempts. Wait a minute and try again.', code: 'rate_limited' },
  });

  app.post('/api/email-login', limiter, async (req, res) => {
    const b = body.parse(req.body ?? {});
    const email = normal(b.email);
    if (!looksLikeEmail(email)) throw new HttpError(400, 'Enter your email address', 'bad_email');
    if (!emailAllowed(email, config)) throw new HttpError(403, `Use your @${EMAIL_DEMO_DOMAIN} email address`, 'email_not_allowed');

    const profile = demoUserFor(email, config.demoUsers);
    const admin = profile.roles.includes(ADMIN_ROLE) || config.demoAdminEmails.includes(email);   // DEMO_USERS roles, or ADMIN_EMAILS

    // An existing account with this address keeps its id; otherwise the deterministic v5 id. The users row is created or refreshed.
    const existing = (await getPool().query('SELECT entra_oid FROM users WHERE lower(email) = $1 ORDER BY created_at LIMIT 1', [email])).rows[0];
    const oid = (existing?.entra_oid as string | undefined) ?? profile.oid;
    await getPool().query(
      `INSERT INTO users (entra_oid, email, display_name, employee_code) VALUES ($1, $2, $3, $4)
       ON CONFLICT (entra_oid) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, employee_code = EXCLUDED.employee_code`,
      [oid, email, profile.displayName, profile.employeeCode]);
    // Umoja membership by the address on the member list, with the same rules as the Entra sign-in (exact lower-cased match; an ambiguous
    // address, or one whose member is already bound to another account, binds nothing and is audited for the admins' warning).
    // In this mode the address is only TYPED, so this proves nothing about who is typing: a test aid, shown with the "Test mode" banner.
    await bindMemberByEmail(getPool(), oid, email);
    await createSession(req, res, config, { oid, email, claimAdmin: admin });
    await audit(getPool(), oid, 'auth.signin', null, { email, mode: 'email-demo', admin });
    res.json({ user: { oid, email, displayName: profile.displayName, roles: admin ? [ADMIN_ROLE] : [], employeeCode: profile.employeeCode } });
  });

  app.post('/api/logout', async (req, res) => {
    await endSession(req, res, config);
    res.status(204).end();
  });
}
