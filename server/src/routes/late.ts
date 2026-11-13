import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { getConfig } from '../config.js';
import { getPool, withTx } from '../db.js';
import { HttpError } from '../errors.js';
import { currentUser } from '../auth/index.js';
import { normalizeEmail } from '../domain/eligibility.js';
import { normalizeEmployeeCode } from '../domain/employeeCode.js';
import { cleanMultiline } from '../domain/text.js';
import { audit } from '../services/audit.js';
import type { CampaignRow } from '../services/campaigns.js';

/**
 * Late voters (business-logic item 10). The voter list is frozen when voting starts (by design); someone hired or reinstated afterwards would
 * otherwise never be able to vote. The CREATOR (not a co-admin) can add one person to a RUNNING vote, with a reason of at least 10
 * characters. It is recorded (`voter.late_added`, who, when, why, and the email or employee code), shown on the Eligibility tab, and listed in the
 * exports and the audit bundle. It can be switched off for the whole system with LATE_VOTERS=false. Leavers keep their vote; their account stops
 * working when IT disables it. A vote open to all staff has nothing to add.
 */

const reason = z.string().transform(cleanMultiline).pipe(z.string().trim().min(10, 'Give a reason of at least 10 characters').max(1000));
const body = z.object({ email: z.string().trim().max(254).optional(), employee_code: z.string().trim().max(32).optional(), reason }).strict()
  .refine((v) => (v.email === undefined) !== (v.employee_code === undefined), { message: 'Give either an email address (listed vote) or an employee code (Umoja vote)' });

export function lateRouter(d: { loadOwned: RequestHandler; loadRunnable: RequestHandler; camp: (res: Response) => CampaignRow }): Router {
  const r = Router({ mergeParams: true });

  r.get('/late-voters', d.loadRunnable, async (_req, res) => {
    const c = d.camp(res);
    const { rows } = await getPool().query(
      `SELECT a.at, u.display_name AS by, a.details FROM audit_log a LEFT JOIN users u ON u.entra_oid = a.actor_oid
        WHERE a.campaign_id = $1 AND a.action = 'voter.late_added' ORDER BY a.seq`, [c.id]);
    res.set('Cache-Control', 'no-store').json({
      enabled: getConfig().lateVoters, applicable: c.eligibility !== 'all', mode: c.eligibility,
      entries: rows.map((x) => ({ at: x.at, by: x.by, identifier: x.details?.email ?? x.details?.employee_code ?? '', reason: x.details?.reason ?? '' })),
    });
  });

  r.post('/late-voters', d.loadOwned, async (req, res) => {
    const c = d.camp(res); const u = currentUser(req);
    const b = body.parse(req.body);
    if (!getConfig().lateVoters) throw new HttpError(409, 'Adding voters to a running vote is switched off (LATE_VOTERS=false)', 'disabled');
    const added = await withTx(async (tx) => {
      const cur = (await tx.query('SELECT status, eligibility FROM campaigns WHERE id = $1 FOR UPDATE', [c.id])).rows[0];
      if (cur.status !== 'open') throw new HttpError(409, cur.status === 'draft' ? 'The vote has not started: add the voter to the list instead' : 'Voting has closed', cur.status === 'draft' ? 'not_started' : 'closed');
      if (cur.eligibility === 'all') throw new HttpError(409, 'This vote is open to all staff, so everyone who can sign in can already vote', 'not_applicable');
      let who: Record<string, string>;
      if (cur.eligibility === 'list') {
        if (b.email === undefined) throw new HttpError(400, 'This is a listed vote: give an email address', 'needs_email');
        const email = normalizeEmail(b.email);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'That is not a valid email address', 'bad_email');
        const ins = await tx.query('INSERT INTO eligible_voters (campaign_id, voter_email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [c.id, email]);
        if (!ins.rowCount) throw new HttpError(409, 'That email address is already on the voter list', 'already_listed');
        who = { email };
      } else {
        if (b.employee_code === undefined) throw new HttpError(400, 'This is an Umoja vote: give the employee code', 'needs_code');
        const code = normalizeEmployeeCode(b.employee_code);
        if (!code) throw new HttpError(400, 'That is not a valid employee code', 'bad_code');
        const m = (await tx.query('SELECT 1 FROM umoja_members WHERE employee_code = $1 AND active', [code])).rowCount;
        if (!m) throw new HttpError(409, 'That employee code is not an active Umoja member on the imported list', 'not_a_member');
        const ins = await tx.query('INSERT INTO campaign_voters (campaign_id, member_code, entra_oid, active) SELECT $1, employee_code, entra_oid, true FROM umoja_members WHERE employee_code = $2 AND active ON CONFLICT DO NOTHING', [c.id, code]);
        if (!ins.rowCount) throw new HttpError(409, 'That member is already in the voter list that was frozen when voting started (listed as not a member at that time). This cannot be changed from here.', 'already_in_list');
        who = { employee_code: code };
      }
      await audit(tx, u.oid, 'voter.late_added', c.id, { mode: cur.eligibility, ...who, reason: b.reason });
      return who;
    });
    res.status(201).json({ added: true, ...added });
  });

  return r;
}
