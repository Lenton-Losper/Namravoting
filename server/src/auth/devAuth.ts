import { z } from 'zod';
import type { Express } from 'express';
import type { Config } from '../config.js';
import { getPool, UNIQUE_VIOLATION } from '../db.js';
import { HttpError } from '../errors.js';
import { ADMIN_ROLE, type AuthUser } from './types.js';
import { DEV_USERS } from './devUsers.js';
import { createSession, endSession, rolesFor } from './sessions.js';
import { normalizeEmployeeCode } from '../domain/employeeCode.js';

/**
 * AUTH_MODE=dev: a local identity picker. The client asserts who it is (including the admin role), so this must never be
 * reachable outside a developer machine: config.ts refuses it when NODE_ENV=production.
 * Sessions are the same server-side sessions as in entra mode (auth/sessions.ts).
 */
const loginBody = z.object({
  oid: z.string().uuid(),
  email: z.string().email().max(254),
  displayName: z.string().trim().min(1).max(120),
  roles: z.array(z.enum([ADMIN_ROLE])).max(1),
  // Dev stub only: the identity picker plays the identity provider, so it "asserts" the code (Entra: employeeId).
  employeeCode: z.string().max(32).nullable().optional(),
}).strict();

export function mount(app: Express, config: Config): void {
  // Dev-only identity picker. Only mounted when AUTH_MODE=dev.
  app.get('/api/dev/users', (_req, res) => { res.json({ users: DEV_USERS }); });

  app.post('/api/dev/login', async (req, res) => {
    const b = loginBody.parse(req.body);
    const employeeCode = normalizeEmployeeCode(b.employeeCode);   // malformed -> null
    const email = b.email.toLowerCase();
    try {
      await getPool().query(
        `INSERT INTO users (entra_oid, email, display_name, employee_code) VALUES ($1, $2, $3, $4)
         ON CONFLICT (entra_oid) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, employee_code = EXCLUDED.employee_code`,
        [b.oid, email, b.displayName, employeeCode],
      );
    } catch (e) {
      if ((e as { code?: string }).code === UNIQUE_VIOLATION) throw new HttpError(409, 'Email already belongs to another user');
      throw e;
    }
    const claimAdmin = b.roles.includes(ADMIN_ROLE);
    await createSession(req, res, config, { oid: b.oid, email, claimAdmin });
    const user: AuthUser = { oid: b.oid, email, displayName: b.displayName, roles: rolesFor(config, { claimAdmin, oid: b.oid, email }), employeeCode };
    res.json({ user });
  });

  app.post('/api/logout', async (req, res) => {
    await endSession(req, res, config);
    res.status(204).end();
  });
}
