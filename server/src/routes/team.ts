import { Router, type Request, type RequestHandler, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { getConfig } from '../config.js';
import { getPool, withTx } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { currentUser, getCurrentUser, requireUser } from '../auth/index.js';
import { clientIp } from '../auth/limits.js';
import { rolesFor } from '../auth/sessions.js';
import { ADMIN_ROLE } from '../auth/types.js';
import { cleanMultiline } from '../domain/text.js';
import { permanentDeleteBody, resetBody } from '../domain/validation.js';
import { audit } from '../services/audit.js';
import { getNotices, getResults, getTurnout, verifySeal, type CampaignRow } from '../services/campaigns.js';

/**
 * Co-admins, observers and the second approver (business-logic item 3).
 *
 * Roles on one campaign: the creator ("owner"); co-admins, who can run it (edit, start, close, publish, export) but not reset, delete,
 * archive or change the team; observers, who can only read: turnout, the sealed result once it is closed, the integrity check and
 * the audit entries (with per-candidate counts held back while the campaign is not closed, like everyone else, SEC-01).
 *
 * Second approver: when a campaign has require_approval (switched on by the creator, never off again), a reset or a permanent delete is
 * REQUESTED by the creator, APPROVED by a co-admin (not the requester: the database refuses it) and then EXECUTED by the creator,
 * within 24 hours of the approval. Every step is audited.
 */

export interface TeamDeps {
  loadOwned: RequestHandler;
  loadRunnable: RequestHandler;
  camp: (res: Response) => CampaignRow;
  shouldAuditDenied: (key: string) => boolean;
  doReset: (req: Request, c: CampaignRow, b: { confirm_title: string; reason: string; closes_at?: string | null }) => Promise<unknown>;
  doPermanentDelete: (req: Request, c: CampaignRow, confirmTitle: string) => Promise<unknown>;
}

export const APPROVAL_VALID_HOURS = 24;
const MAX_TEAM = 20;

const memberBody = z.object({ email: z.string().trim().toLowerCase().email().max(254), role: z.enum(['co_admin', 'observer']) }).strict();
const policyBody = z.object({ require_approval: z.literal(true) }).strict();
const noteBody = z.object({ note: z.string().transform(cleanMultiline).pipe(z.string().trim().max(500)).optional() }).strict();
const requestBody = z.discriminatedUnion('kind', [
  resetBody.extend({ kind: z.literal('reset') }).strict(),
  permanentDeleteBody.extend({ kind: z.literal('permanent_delete') }).strict(),
]);
const idParam = z.object({ id: z.string().uuid(), aid: z.string().uuid().optional(), oid: z.string().uuid().optional() });

export function teamRouter(d: TeamDeps): Router {
  const r = Router({ mergeParams: true });

  const view = async (id: string) => {
    const db = getPool();
    const owner = (await db.query('SELECT u.display_name AS name, u.email FROM campaigns c JOIN users u ON u.entra_oid = c.created_by WHERE c.id = $1', [id])).rows[0];
    const members = (await db.query(
      `SELECT m.user_oid AS oid, m.role, m.added_at, u.display_name AS name, u.email FROM campaign_members m JOIN users u ON u.entra_oid = m.user_oid
        WHERE m.campaign_id = $1 ORDER BY m.role, u.display_name`, [id])).rows;
    const approvals = (await db.query(
      `SELECT a.id, a.kind, a.status, a.payload, a.requested_at, a.decided_at, a.decision_note, a.executed_at, a.requested_by, a.decided_by,
              ru.display_name AS requested_by_name, du.display_name AS decided_by_name,
              (a.status = 'approved' AND a.decided_at > now() - make_interval(hours => $2)) AS executable
         FROM approvals a JOIN users ru ON ru.entra_oid = a.requested_by LEFT JOIN users du ON du.entra_oid = a.decided_by
        WHERE a.campaign_id = $1 ORDER BY a.requested_at DESC LIMIT 50`, [id, APPROVAL_VALID_HOURS])).rows;
    return { owner, members, approvals };
  };

  r.get('/team', d.loadRunnable, async (req, res) => {
    const c = d.camp(res);
    res.set('Cache-Control', 'no-store').json({ ...(await view(c.id)), require_approval: !!c.require_approval, my_role: res.locals.myRole, approval_valid_hours: APPROVAL_VALID_HOURS });
  });

  r.post('/team', d.loadOwned, async (req, res) => {
    const c = d.camp(res); const u = currentUser(req);
    const b = memberBody.parse(req.body);
    const target = (await getPool().query('SELECT entra_oid, email, display_name FROM users WHERE email = $1', [b.email])).rows[0];
    if (!target) throw new HttpError(404, 'No one with that email has signed in to NamRA Voting yet. Ask them to sign in once, then add them.', 'no_such_user');
    if (target.entra_oid === u.oid) throw new HttpError(400, 'You already own this campaign', 'is_owner');
    if (b.role === 'co_admin') {
      // A co-admin works in the admin area, so they must already be an administrator (ADMIN_OIDS, the app role, or a live admin session).
      const claim = (await getPool().query('SELECT coalesce(bool_or(claim_admin), false) AS c FROM sessions WHERE user_oid = $1 AND revoked_at IS NULL AND expires_at > now()', [target.entra_oid])).rows[0].c as boolean;
      const admin = rolesFor(getConfig(), { claimAdmin: claim, oid: target.entra_oid, email: target.email }).includes(ADMIN_ROLE);
      if (!admin) throw new HttpError(409, 'A co-admin must be a campaign administrator. Ask IT to give that person the CampaignAdmin role first.', 'not_admin');
    }
    await withTx(async (tx) => {
      await tx.query('SELECT 1 FROM campaigns WHERE id = $1 FOR UPDATE', [c.id]);
      const n = (await tx.query('SELECT count(*)::int AS n FROM campaign_members WHERE campaign_id = $1', [c.id])).rows[0].n as number;
      if (n >= MAX_TEAM) throw new HttpError(409, `A campaign can have at most ${MAX_TEAM} co-admins and observers`, 'team_full');
      if ((await tx.query('SELECT 1 FROM campaign_members WHERE campaign_id = $1 AND user_oid = $2', [c.id, target.entra_oid])).rowCount) {
        throw new HttpError(409, 'That person already has a role on this campaign. Remove them first to change it.', 'already_member');
      }
      await tx.query('INSERT INTO campaign_members (campaign_id, user_oid, role, added_by) VALUES ($1, $2, $3, $4)', [c.id, target.entra_oid, b.role, u.oid]);
      await audit(tx, u.oid, 'team.add', c.id, { member: target.entra_oid, name: target.display_name, role: b.role });
    });
    res.status(201).json(await view(c.id));
  });

  r.delete('/team/:oid', d.loadOwned, async (req, res) => {
    const c = d.camp(res); const u = currentUser(req);
    const { oid } = idParam.parse(req.params);
    await withTx(async (tx) => {
      const { rows } = await tx.query('DELETE FROM campaign_members WHERE campaign_id = $1 AND user_oid = $2 RETURNING role', [c.id, oid]);
      if (!rows.length) throw notFound();
      await audit(tx, u.oid, 'team.remove', c.id, { member: oid, role: rows[0].role });
    });
    res.status(204).end();
  });

  r.put('/approval-policy', d.loadOwned, async (req, res) => {
    const c = d.camp(res); const u = currentUser(req);
    policyBody.parse(req.body);
    if (!c.require_approval) {
      await withTx(async (tx) => {
        await tx.query('UPDATE campaigns SET require_approval = true WHERE id = $1', [c.id]);
        await audit(tx, u.oid, 'campaign.require_approval', c.id, { on: true });
      });
    }
    res.json({ require_approval: true });
  });

  // ---- approvals -------------------------------------------------------------------------------------------------

  r.post('/approvals', d.loadOwned, async (req, res) => {
    const c = d.camp(res); const u = currentUser(req);
    const b = requestBody.parse(req.body);
    if (!c.require_approval) throw new HttpError(409, 'This campaign does not need approval. Reset or delete it directly.', 'not_required');
    if (b.confirm_title !== c.title) throw new HttpError(400, 'The title you typed does not match', 'title_mismatch');
    if (b.kind === 'reset' && (c.status === 'draft' || c.archived_at)) throw new HttpError(409, c.archived_at ? 'Unarchive the campaign before resetting it' : 'A draft has no votes to reset', 'bad_state');
    if (b.kind === 'permanent_delete' && (!c.archived_at || c.status !== 'closed')) throw new HttpError(409, 'Archive the campaign first. Only archived campaigns can be deleted permanently.', 'not_archived');
    const payload = b.kind === 'reset' ? { title: c.title, reason: b.reason, closes_at: b.closes_at ?? null } : { title: c.title };
    const row = await withTx(async (tx) => {
      await tx.query('SELECT 1 FROM campaigns WHERE id = $1 FOR UPDATE', [c.id]);
      if ((await tx.query("SELECT 1 FROM approvals WHERE campaign_id = $1 AND kind = $2 AND status IN ('pending', 'approved')", [c.id, b.kind])).rowCount) {
        throw new HttpError(409, 'There is already an open request of this kind. Finish or cancel it first.', 'request_open');
      }
      const ins = await tx.query('INSERT INTO approvals (campaign_id, kind, payload, requested_by) VALUES ($1, $2, $3, $4) RETURNING id', [c.id, b.kind, JSON.stringify(payload), u.oid]);
      await audit(tx, u.oid, 'approval.requested', c.id, { approval: ins.rows[0].id, kind: b.kind, ...(b.kind === 'reset' ? { reason: b.reason } : {}) });
      return ins.rows[0];
    });
    res.status(201).json({ id: row.id, ...(await view(c.id)) });
  });

  const decide = (decision: 'approved' | 'rejected'): RequestHandler => async (req, res) => {
    const c = d.camp(res); const u = currentUser(req);
    const { aid } = idParam.parse(req.params);
    const b = noteBody.parse(req.body ?? {});
    // Only a co-admin decides. The creator is the one who asks, so the person who decides is always a second person.
    if (res.locals.myRole !== 'co_admin') throw new HttpError(403, 'Only a co-admin can approve or reject a request', 'not_co_admin');
    await withTx(async (tx) => {
      const a = (await tx.query('SELECT status, kind, requested_by FROM approvals WHERE id = $1 AND campaign_id = $2 FOR UPDATE', [aid, c.id])).rows[0];
      if (!a) throw notFound();
      if (a.requested_by === u.oid) throw new HttpError(403, 'You cannot approve your own request', 'self_approval');
      if (a.status !== 'pending') throw new HttpError(409, 'This request has already been decided', 'already_decided');
      await tx.query('UPDATE approvals SET status = $3, decided_by = $4, decided_at = now(), decision_note = $5 WHERE id = $1 AND campaign_id = $2', [aid, c.id, decision, u.oid, b.note ?? null]);
      await audit(tx, u.oid, `approval.${decision}`, c.id, { approval: aid, kind: a.kind, ...(b.note ? { note: b.note } : {}) });
    });
    res.json(await view(c.id));
  };
  r.post('/approvals/:aid/approve', d.loadRunnable, decide('approved'));
  r.post('/approvals/:aid/reject', d.loadRunnable, decide('rejected'));

  r.post('/approvals/:aid/cancel', d.loadOwned, async (req, res) => {
    const c = d.camp(res); const u = currentUser(req);
    const { aid } = idParam.parse(req.params);
    await withTx(async (tx) => {
      const a = (await tx.query('SELECT status, kind FROM approvals WHERE id = $1 AND campaign_id = $2 FOR UPDATE', [aid, c.id])).rows[0];
      if (!a) throw notFound();
      if (!['pending', 'approved'].includes(a.status)) throw new HttpError(409, 'This request is already finished', 'already_decided');
      await tx.query("UPDATE approvals SET status = 'cancelled' WHERE id = $1", [aid]);
      await audit(tx, u.oid, 'approval.cancelled', c.id, { approval: aid, kind: a.kind });
    });
    res.json(await view(c.id));
  });

  /** The creator carries out an APPROVED request (within 24 hours). Re-checks the title and the state; the database functions re-check the rest. */
  r.post('/approvals/:aid/execute', d.loadOwned, async (req, res) => {
    const c = d.camp(res); const u = currentUser(req);
    const { aid } = idParam.parse(req.params);
    // Claim it: only one execution can ever start (executed_at is set while it is still 'approved'); released again if the action fails.
    const claimed = (await getPool().query(
      `UPDATE approvals SET executed_at = now()
        WHERE id = $1 AND campaign_id = $2 AND status = 'approved' AND executed_at IS NULL AND decided_at > now() - make_interval(hours => $3)
        RETURNING kind, payload, decided_by`, [aid, c.id, APPROVAL_VALID_HOURS])).rows[0];
    if (!claimed) {
      const a = (await getPool().query('SELECT status, executed_at, decided_at FROM approvals WHERE id = $1 AND campaign_id = $2', [aid, c.id])).rows[0];
      if (!a) throw notFound();
      if (a.status === 'approved' && !a.executed_at) throw new HttpError(409, `The approval is older than ${APPROVAL_VALID_HOURS} hours. Cancel this request and ask again.`, 'approval_expired');
      throw new HttpError(409, a.status === 'pending' ? 'This request has not been approved yet' : 'This request cannot be carried out', 'not_approved');
    }
    try {
      if (claimed.payload.title !== c.title) throw new HttpError(409, 'The campaign title changed after the request was made. Cancel it and ask again.', 'title_changed');
      const result = claimed.kind === 'reset'
        ? await d.doReset(req, c, { confirm_title: claimed.payload.title, reason: claimed.payload.reason, closes_at: claimed.payload.closes_at ?? null })
        : await d.doPermanentDelete(req, c, claimed.payload.title);
      await getPool().query("UPDATE approvals SET status = 'executed' WHERE id = $1", [aid]);   // gone with the campaign after a permanent delete: no row, fine
      await audit(getPool(), u.oid, 'approval.executed', c.id, { approval: aid, kind: claimed.kind, approved_by: claimed.decided_by });
      res.json({ executed: true, result });
    } catch (e) {
      await getPool().query('UPDATE approvals SET executed_at = NULL WHERE id = $1 AND status = \'approved\'', [aid]).catch(() => undefined);
      throw e;
    }
  });

  return r;
}

// ---- Observers: a read-only view of the campaigns one has been asked to watch ------------------------------------------

/** Redacts per-candidate counts from an audit entry while the campaign is not closed (SEC-01), for everyone but the creator. */
function redact(details: Record<string, any> | null, closed: boolean): Record<string, unknown> | null {
  if (!details || closed) return details;
  const out = { ...details };
  delete out.tallies;
  if (out.snapshot && typeof out.snapshot === 'object') out.snapshot = { turnout: (out.snapshot as Record<string, unknown>).turnout };
  return out;
}

export function observeRouter(): Router {
  const r = Router();
  r.use(requireUser, rateLimit({
    windowMs: 60_000, limit: getConfig().readRateLimit, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: (req) => getCurrentUser(req as Request)?.oid ?? ipKeyGenerator(clientIp(req as Request)),
    message: { error: 'Too many requests' },
  }));

  r.get('/', async (req, res) => {
    const u = currentUser(req);
    const { rows } = await getPool().query(
      `SELECT c.id, c.title, c.status, c.opens_at, c.closes_at, c.results_published, c.archived_at, o.display_name AS owner,
              (SELECT count(*)::int FROM vote_receipts v WHERE v.campaign_id = c.id) AS turnout
         FROM campaign_members m JOIN campaigns c ON c.id = m.campaign_id JOIN users o ON o.entra_oid = c.created_by
        WHERE m.user_oid = $1 AND m.role = 'observer' ORDER BY c.created_at DESC`, [u.oid]);
    res.set('Cache-Control', 'no-store').json({ campaigns: rows });
  });

  r.get('/:id', async (req, res) => {
    const { id } = idParam.parse(req.params);
    const u = currentUser(req);
    const c = (await getPool().query(
      `SELECT c.*, o.display_name AS owner FROM campaigns c JOIN users o ON o.entra_oid = c.created_by
        WHERE c.id = $1 AND EXISTS (SELECT 1 FROM campaign_members m WHERE m.campaign_id = c.id AND m.user_oid = $2 AND m.role = 'observer')`, [id, u.oid])).rows[0];
    if (!c) {
      await audit(getPool(), u.oid, 'authz.denied', id, { reason: 'not_observer', method: req.method, path: req.path }).catch(() => undefined);
      throw notFound();
    }
    const closed = c.status === 'closed';
    const db = getPool();
    const team = (await db.query('SELECT u.display_name AS name, m.role FROM campaign_members m JOIN users u ON u.entra_oid = m.user_oid WHERE m.campaign_id = $1 ORDER BY m.role, u.display_name', [id])).rows;
    const approvals = (await db.query(
      `SELECT a.kind, a.status, a.payload->>'reason' AS reason, a.requested_at, ru.display_name AS requested_by, du.display_name AS decided_by, a.decided_at, a.executed_at
         FROM approvals a JOIN users ru ON ru.entra_oid = a.requested_by LEFT JOIN users du ON du.entra_oid = a.decided_by WHERE a.campaign_id = $1 ORDER BY a.requested_at DESC LIMIT 50`, [id])).rows;
    const audit_ = (await db.query(
      `SELECT a.seq, a.at, a.action, au.display_name AS actor, a.details, a.hash FROM audit_log a LEFT JOIN users au ON au.entra_oid = a.actor_oid
        WHERE a.campaign_id = $1 ORDER BY a.seq DESC LIMIT 1000`, [id])).rows.reverse();
    res.set('Cache-Control', 'no-store').json({
      id: c.id, title: c.title, description: c.description, status: c.status, eligibility: c.eligibility, owner: c.owner,
      opens_at: c.opens_at, closes_at: c.closes_at, results_published: c.results_published, archived: !!c.archived_at, require_approval: !!c.require_approval,
      turnout: await getTurnout(db, id),
      // The sealed result exists only once the campaign is closed. While it runs an observer sees turnout, never per-candidate counts.
      result: closed ? await getResults(db, id) : null,
      seal: closed ? await verifySeal(db, id) : null,
      notices: await getNotices(db, id, closed),
      team, approvals,
      audit: audit_.map((a) => ({ seq: a.seq, at: a.at, action: a.action, actor: a.actor, hash: a.hash, details: redact(a.details, closed) })),
    });
  });

  return r;
}


