import { activeMemberCount, snapshotVoters } from '../services/umoja.js';
import { createTallies } from '../services/tallies.js';
import crypto from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import PDFDocument from 'pdfkit';
import { teamRouter } from './team.js';
import { buildPdf, buildXlsx, gatherExport } from '../services/resultsExport.js';
import QRCode from 'qrcode';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { PoolClient } from 'pg';
import { getConfig } from '../config.js';
import { getPool, withTx } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { ADMIN_ROLE, currentUser, getCurrentUser, isAdmin, requireUser } from '../auth/index.js';
import { clientIp } from '../auth/limits.js';
import { sessionRawId } from '../auth/sessions.js';
import { normalizeEmail } from '../domain/eligibility.js';
import {
  ackBody, candParams, candidateBody, candidatePatchBody, closeBody, createCampaignBody, eligibleBody, idParams, patchCampaignBody, permanentDeleteBody, resetBody,
} from '../domain/validation.js';
import { audit } from '../services/audit.js';
import {
  closeInTx, getNotices, getResults, getTurnout, IntegrityBlocked, integrityMessage, openIntegrityBlock, recordIntegrityBlock, refreshStatus, verifySeal, type CampaignRow,
} from '../services/campaigns.js';
import { deletePhoto, MAX_UPLOAD_BYTES, readPhoto, savePhoto } from '../services/images.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5, fieldSize: 4096 } });

/**
 * Denials are audit-logged, but a client in a loop must not be able to fill the audit log (SEC-08): the same denial by the
 * same user is written once per 10 minutes (the request itself is still refused every time, and is rate limited).
 */
const deniedSeen = new Map<string, number>();
const DENIED_WINDOW_MS = 10 * 60_000;
function shouldAuditDenied(key: string): boolean {
  const now = Date.now();
  if (deniedSeen.size > 5000) for (const [k, t] of deniedSeen) if (now - t > DENIED_WINDOW_MS) deniedSeen.delete(k);
  const last = deniedSeen.get(key);
  if (last !== undefined && now - last < DENIED_WINDOW_MS) return false;
  deniedSeen.set(key, now);
  return true;
}

/** Admin gate: role check; failures are audit-logged (once per user and request per 10 minutes). */
const requireAdmin: RequestHandler = async (req, res, next) => {
  const u = currentUser(req);
  if (!isAdmin(u)) {
    if (shouldAuditDenied(`${u.oid}|not_admin|${req.method} ${req.path}`)) await audit(getPool(), u.oid, 'authz.denied', null, { reason: 'not_admin', method: req.method, path: req.path });
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
};

/** Per-user admin rate limit (falls back to IP if somehow unauthenticated). */
const adminLimiter = () => rateLimit({
  windowMs: 60_000, limit: getConfig().adminRateLimit, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => getCurrentUser(req as Request)?.oid ?? ipKeyGenerator(clientIp(req as Request)),
  message: { error: 'Too many requests' },
});

/**
 * Ownership gate for every campaign-specific route. Non-owner and non-existent both answer 404
 * (so ids aren't confirmed) and the attempt is audit-logged (outside any transaction so it persists).
 */
const loadOwned: RequestHandler = async (req, res, next) => {
  const { id } = idParams.parse(req.params);
  const u = currentUser(req);
  await refreshStatus(id).catch(() => undefined);
  const { rows } = await getPool().query('SELECT * FROM campaigns WHERE id = $1', [id]);
  const c = rows[0] as CampaignRow | undefined;
  if (!c || c.created_by !== u.oid) {
    if (shouldAuditDenied(`${u.oid}|not_owner|${req.method} ${req.path}`)) await audit(getPool(), u.oid, 'authz.denied', id, { reason: 'not_owner', method: req.method, path: req.path });
    next(notFound());
    return;
  }
  res.locals.campaign = c;
  next();
};
/**
 * Gate for everything that RUNS a campaign (edit, start, close, publish, export): the creator or a co-admin of that campaign.
 * Reset, delete, archive and the team itself stay with the creator (loadOwned). Same 404-and-audit answer for everyone else.
 */
const loadRunnable: RequestHandler = async (req, res, next) => {
  const { id } = idParams.parse(req.params);
  const u = currentUser(req);
  await refreshStatus(id).catch(() => undefined);
  const { rows } = await getPool().query(
    `SELECT c.*, CASE WHEN c.created_by = $2 THEN 'owner' ELSE m.role END AS my_role
       FROM campaigns c LEFT JOIN campaign_members m ON m.campaign_id = c.id AND m.user_oid = $2 AND m.role = 'co_admin' WHERE c.id = $1`, [id, u.oid]);
  const c = rows[0] as (CampaignRow & { my_role: string | null }) | undefined;
  if (!c || !c.my_role) {
    if (shouldAuditDenied(`${u.oid}|not_owner|${req.method} ${req.path}`)) await audit(getPool(), u.oid, 'authz.denied', id, { reason: 'not_owner', method: req.method, path: req.path });
    next(notFound());
    return;
  }
  res.locals.campaign = c;
  res.locals.myRole = c.my_role;
  next();
};
const camp = (res: Response) => res.locals.campaign as CampaignRow;

/** Run-off context of a closed campaign: the run-off it led to (if any), the one it is part of (if any), and whether one may be started. */
async function runoffInfo(c: CampaignRow) {
  const child = (await getPool().query('SELECT id, title, status FROM campaigns WHERE parent_campaign_id = $1 ORDER BY created_at LIMIT 1', [c.id])).rows[0] ?? null;
  const parent = c.parent_campaign_id ? (await getPool().query('SELECT id, title FROM campaigns WHERE id = $1', [c.parent_campaign_id])).rows[0] ?? null : null;
  const max = getConfig().maxRunoffs;
  return { round: c.runoff_round ?? 0, max, next: child, parent, can_start: !child && !c.archived_at && (c.runoff_round ?? 0) < max };
}

/** Runs fn in a tx holding a row lock on the campaign; rejects unless it is still a draft. */
async function inDraftTx<T>(id: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTx(async (c) => {
    const { rows } = await c.query('SELECT status FROM campaigns WHERE id = $1 FOR UPDATE', [id]);
    if (rows[0]?.status !== 'draft') throw new HttpError(409, 'Campaign is locked: only drafts can be edited', 'locked');
    return fn(c);
  });
}

/**
 * Like inDraftTx, but a campaign that was created with "Allow edits after start" can also be edited while it is OPEN (the callback
 * gets live = true). Which fields and candidates may change in that case is decided by each route (and enforced again by the
 * database, migration 012). Everything runs under a row lock on the campaign, which a vote also takes, so edit and vote are serialised.
 */
async function inEditTx<T>(id: string, fn: (c: PoolClient, live: boolean) => Promise<T>): Promise<T> {
  return withTx(async (c) => {
    const { rows } = await c.query('SELECT status, allow_edits_after_start FROM campaigns WHERE id = $1 FOR UPDATE', [id]);
    const r = rows[0];
    if (r?.status === 'draft') return fn(c, false);
    if (r?.status === 'open' && r.allow_edits_after_start) return fn(c, true);
    throw new HttpError(409, r?.status === 'open' ? 'This campaign was created without "Allow edits after start", so it is locked' : 'Campaign is locked: only drafts can be edited', 'locked');
  });
}

/** Candidates of a started campaign can change only until the first vote is cast. */
async function requireNoVotes(c: PoolClient, id: string): Promise<void> {
  if ((await c.query('SELECT 1 FROM vote_receipts WHERE campaign_id = $1 LIMIT 1', [id])).rowCount) {
    throw new HttpError(409, 'Candidates can no longer be changed: the first vote has been cast', 'votes_cast');
  }
}

/** One audit entry per post-start edit. The entry is what voters and the results page show as "Edited after start". */
type EditChange = { what: 'title' | 'description' | 'closes_at' | 'candidate_added' | 'candidate_edited' | 'candidate_removed'; name?: string; from?: string | null; to?: string | null };
const trunc = (v: string | null | undefined) => (v == null ? null : v.length > 300 ? v.slice(0, 300) + '…' : v);
const auditEdit = (tx: PoolClient, actor: string, id: string, changes: EditChange[]) => audit(tx, actor, 'campaign.edit_after_start', id, { changes });
const sameInstant = (a: string | null | undefined, b: Date | null) => (a == null ? b == null : b != null && new Date(a).getTime() === b.getTime());

/** The ballot's Abstain line: a candidate row flagged is_abstain (sorted last), so it gets a tally counter like everyone else. */
export const ABSTAIN_NAME = 'Abstain (none of the above)';
async function setAbstain(tx: PoolClient, id: string, on: boolean): Promise<void> {
  await tx.query('UPDATE campaigns SET allow_abstain = $2 WHERE id = $1', [id, on]);
  if (on) await tx.query('INSERT INTO candidates (campaign_id, name, sort_order, is_abstain) VALUES ($1, $2, 2000000000, true) ON CONFLICT DO NOTHING', [id, ABSTAIN_NAME]);
  else await tx.query('DELETE FROM candidates WHERE campaign_id = $1 AND is_abstain', [id]);
}

/** Validates and de-duplicates a list of voter emails (shared by creating a campaign and by setting eligibility). */
function cleanEmails(raw: string[]): string[] {
  const norm = raw.map(normalizeEmail);
  const bad = norm.filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (bad.length) throw new HttpError(400, `Invalid email address(es): ${bad.slice(0, 5).join(', ')}`);
  return [...new Set(norm)];
}

/**
 * Calls one of the SECURITY DEFINER clean-up functions (migration 005). They re-check creator + state inside the database and
 * signal with custom SQLSTATEs: NR404 -> 404 (also for "not yours", so ids are not confirmed), NR409 -> 409, NR400 -> 400.
 */
async function callCleanup(sql: string, params: unknown[], conflictMessage: (status: string | null, archived: boolean) => { message: string; code: string }, campaignId: string): Promise<Record<string, any>> {
  try {
    return (await getPool().query(sql, params)).rows[0].result as Record<string, any>;
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'NR401') throw new HttpError(401, 'Not signed in');
    if (code === 'NR404') throw notFound();
    if (code === 'NR400') throw new HttpError(400, (e as Error).message, 'invalid');
    if (code === 'NR409') {
      const msg = (e as Error).message;
      if (msg.startsWith('the closing time')) throw new HttpError(409, msg[0].toUpperCase() + msg.slice(1), 'needs_new_close');
      const f = (await getPool().query('SELECT status, archived_at FROM campaigns WHERE id = $1', [campaignId])).rows[0];
      const m = conflictMessage(f?.status ?? null, !!f?.archived_at);
      throw new HttpError(409, m.message, m.code);
    }
    throw e;
  }
}

/** Photo files are removed only AFTER the database transaction committed. A storage hiccup never undoes the deletion. */
async function removePhotos(photos: unknown): Promise<void> {
  for (const p of Array.isArray(photos) ? photos : []) {
    try { await deletePhoto(String(p)); } catch (e) { console.warn(`[cleanup] could not delete a photo file: ${(e as Error).message}`); }
  }
}

/** Campaigns the caller sees on the dashboard: their own, and those they co-administer. (Observers have their own page.) */
const VISIBLE = "(c.created_by = $1 OR EXISTS (SELECT 1 FROM campaign_members m WHERE m.campaign_id = c.id AND m.user_oid = $1 AND m.role = 'co_admin'))";
const shareUrl = (token: string) => `${getConfig().publicBaseUrl}/v/${token}`;
const present = (c: CampaignRow) => ({ ...c, share_url: shareUrl(c.share_token) });
const photoUrl = (cand: { id: string; photo_path: string | null }) => (cand.photo_path ? `/api/photos/${cand.id}` : null);
const csvCell = (v: string) => { const s = /^[=+\-@\t\r]/.test(v) ? "'" + v : v; return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };

export function adminRouter(): Router {
  const r = Router();
  r.use(requireUser, adminLimiter(), requireAdmin);   // the limiter runs first, so a non-admin cannot hammer the admin gate (SEC-08)

  r.get('/mine', async (req, res) => {
    const u = currentUser(req);
    const open = await getPool().query("SELECT id FROM campaigns c WHERE " + VISIBLE + " AND status = 'open'", [u.oid]);
    for (const row of open.rows) await refreshStatus(row.id);
    const { rows } = await getPool().query(
      `SELECT c.*, (SELECT count(*)::int FROM vote_receipts v WHERE v.campaign_id = c.id) AS turnout,
              CASE c.eligibility WHEN 'list' THEN (SELECT count(*)::int FROM eligible_voters e WHERE e.campaign_id = c.id)
                                WHEN 'umoja' THEN (CASE WHEN c.status = 'draft' THEN (SELECT count(*)::int FROM umoja_members WHERE active)
                                                     ELSE (SELECT count(*)::int FROM campaign_voters v WHERE v.campaign_id = c.id AND v.active) END) END AS eligible_count
         FROM campaigns c WHERE ${VISIBLE} ORDER BY c.created_at DESC`, [u.oid]);
    res.json({ campaigns: rows.map((c) => ({ ...present(c), turnout: c.turnout, eligible_count: c.eligible_count })) });
  });

  /**
   * Dashboard data, scoped to the caller's own campaigns. Receipts and tallies carry no timestamps by design,
   * so there is no "votes today" figure; `votes_open` is the total cast across open campaigns.
   */
  r.get('/summary', async (req, res) => {
    const u = currentUser(req);
    const mine = await getPool().query("SELECT id FROM campaigns c WHERE " + VISIBLE + " AND status = 'open'", [u.oid]);
    for (const row of mine.rows) await refreshStatus(row.id);
    const { rows } = await getPool().query(
      `SELECT c.id, c.title, c.status, c.created_at, c.opens_at, c.closes_at, c.eligibility, c.results_published, c.archived_at,
              (SELECT count(*)::int FROM vote_receipts v WHERE v.campaign_id = c.id) AS turnout,
              CASE c.eligibility WHEN 'list' THEN (SELECT count(*)::int FROM eligible_voters e WHERE e.campaign_id = c.id)
                                WHEN 'umoja' THEN (CASE WHEN c.status = 'draft' THEN (SELECT count(*)::int FROM umoja_members WHERE active)
                                                     ELSE (SELECT count(*)::int FROM campaign_voters v WHERE v.campaign_id = c.id AND v.active) END) END AS eligible_count,
              (SELECT min(a.at) FROM audit_log a WHERE a.campaign_id = c.id AND a.action = 'campaign.start') AS started_at,
              (SELECT max(a.at) FROM audit_log a WHERE a.campaign_id = c.id AND a.action LIKE 'campaign.close%') AS closed_at
         FROM campaigns c WHERE ${VISIBLE} ORDER BY c.created_at DESC`, [u.oid]);

    const closedIds = rows.filter((c) => c.status === 'closed').map((c) => c.id as string);
    const tallies = closedIds.length
      ? (await getPool().query(
          `SELECT c.campaign_id, c.id, c.name, c.photo_path, coalesce(t.votes, 0)::int AS votes
             FROM candidates c LEFT JOIN tallies t ON t.candidate_id = c.id AND t.campaign_id = c.campaign_id
            WHERE c.campaign_id = ANY($1::uuid[]) AND NOT c.is_abstain`, [closedIds])).rows
      : [];
    const winnerOf = (cid: string) => {
      const t = tallies.filter((x) => x.campaign_id === cid).sort((a, b) => b.votes - a.votes);
      if (!t.length || t[0].votes === 0) return null;
      const tie = t.length > 1 && t[1].votes === t[0].votes;
      return { id: t[0].id as string, name: t[0].name as string, votes: t[0].votes as number, tie, photo_url: t[0].photo_path ? `/api/photos/${t[0].id}` : null };
    };
    const slim = (c: (typeof rows)[number]) => ({
      id: c.id, title: c.title, status: c.status, created_at: c.created_at, opens_at: c.opens_at, closes_at: c.closes_at,
      started_at: c.started_at, closed_at: c.closed_at, results_published: c.results_published, archived_at: c.archived_at,
      turnout: c.turnout, eligible_count: c.eligible_count,
    });
    const open = rows.filter((c) => c.status === 'open');
    const drafts = rows.filter((c) => c.status === 'draft');
    const archived = rows.filter((c) => c.archived_at);
    const featured = open[0] ?? drafts[0] ?? null;
    res.set('Cache-Control', 'no-store').json({
      counts: { active: open.length, drafts: drafts.length, archived: archived.length, votes_open: open.reduce((n, c) => n + c.turnout, 0) },
      open: open.map(slim),
      featured: featured ? slim(featured) : null,
      closed: rows.filter((c) => c.status === 'closed' && !c.archived_at).map((c) => ({ ...slim(c), winner: winnerOf(c.id) })),
      archived: archived.map((c) => ({ ...slim(c), winner: winnerOf(c.id) })),
    });
  });

  r.post('/', async (req, res) => {
    const u = currentUser(req);
    const b = createCampaignBody.parse(req.body);
    const token = crypto.randomBytes(24).toString('base64url');   // 32 URL-safe chars
    const eligibility = b.eligibility ?? 'umoja';   // the mode the creator chose is what gets saved
    const emails = eligibility === 'list' ? cleanEmails(b.emails ?? []) : [];
    const created = await withTx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO campaigns (share_token, created_by, title, description, opens_at, closes_at, eligibility, allow_edits_after_start, allow_abstain, require_approval)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [token, u.oid, b.title, b.description ?? null, b.opens_at ?? null, b.closes_at ?? null, eligibility, b.allow_edits_after_start === true, b.allow_abstain === true, b.require_approval === true]);
      if (b.allow_abstain === true) await setAbstain(c, rows[0].id, true);
      if (emails.length) await c.query('INSERT INTO eligible_voters (campaign_id, voter_email) SELECT $1, unnest($2::text[])', [rows[0].id, emails]);
      await audit(c, u.oid, 'campaign.create', rows[0].id, { title: b.title, eligibility, allow_edits_after_start: b.allow_edits_after_start === true, allow_abstain: b.allow_abstain === true, require_approval: b.require_approval === true, ...(emails.length ? { count: emails.length } : {}) });
      return rows[0] as CampaignRow;
    });
    res.status(201).json(present(created));
  });

  r.get('/:id', loadRunnable, async (_req, res) => {
    const c = camp(res);
    const cands = await getPool().query(
      'SELECT id, name, bio, photo_path, sort_order FROM candidates WHERE campaign_id = $1 AND NOT is_abstain ORDER BY sort_order, name', [c.id]);
    const el = await getPool().query('SELECT voter_email FROM eligible_voters WHERE campaign_id = $1 ORDER BY voter_email', [c.id]);
    res.json({
      ...present(c),
      my_role: res.locals.myRole as string,
      candidates: cands.rows.map((x) => ({ id: x.id, name: x.name, bio: x.bio, photo_url: photoUrl(x), sort_order: x.sort_order })),
      eligible_emails: el.rows.map((x) => x.voter_email),
      turnout: (await getPool().query('SELECT count(*)::int AS n FROM vote_receipts WHERE campaign_id = $1', [c.id])).rows[0].n,
      umoja_active_count: await activeMemberCount(getPool()),   // count only; never the members themselves
      integrity_block: c.status === 'open' ? await openIntegrityBlock(getPool(), c.id) : null,   // SEC-16
      edited_after_start: (await getNotices(getPool(), c.id, false)).filter((n) => n.kind === 'edited_after_start'),
    });
  });

  r.patch('/:id', loadRunnable, async (req, res) => {
    const c = camp(res);
    const b = patchCampaignBody.parse(req.body);
    const actor = currentUser(req).oid;
    const updated = await inEditTx(c.id, async (tx, live) => {
      if (!live) {
        const { rows } = await tx.query(
          `UPDATE campaigns SET
             title = CASE WHEN $2::boolean THEN $3 ELSE title END,
             description = CASE WHEN $4::boolean THEN $5 ELSE description END,
             opens_at = CASE WHEN $6::boolean THEN $7::timestamptz ELSE opens_at END,
             closes_at = CASE WHEN $8::boolean THEN $9::timestamptz ELSE closes_at END,
             allow_edits_after_start = CASE WHEN $10::boolean THEN $11 ELSE allow_edits_after_start END
           WHERE id = $1 RETURNING *`,
          [c.id, b.title !== undefined, b.title ?? null, b.description !== undefined, b.description ?? null,
           b.opens_at !== undefined, b.opens_at ?? null, b.closes_at !== undefined, b.closes_at ?? null,
           b.allow_edits_after_start !== undefined, b.allow_edits_after_start ?? false]);
        const row = rows[0] as CampaignRow;
        if (b.allow_abstain !== undefined && b.allow_abstain !== row.allow_abstain) { await setAbstain(tx, c.id, b.allow_abstain); row.allow_abstain = b.allow_abstain; }
        if (row.opens_at && row.closes_at && row.closes_at <= row.opens_at) throw new HttpError(400, 'closes_at must be after opens_at');
        await audit(tx, actor, 'campaign.update', c.id, { fields: Object.keys(b) });
        return row;
      }

      // Open campaign with "Allow edits after start": title, description and closing time only. Everything else stays locked.
      const cur = (await tx.query('SELECT *, clock_timestamp() AS db_now FROM campaigns WHERE id = $1', [c.id])).rows[0] as CampaignRow & { allow_edits_after_start: boolean };
      if (b.allow_edits_after_start !== undefined && b.allow_edits_after_start !== cur.allow_edits_after_start) {
        throw new HttpError(409, '"Allow edits after start" cannot be changed once voting has started', 'locked');
      }
      if (b.allow_abstain !== undefined && b.allow_abstain !== cur.allow_abstain) throw new HttpError(409, 'The Abstain option cannot be changed once voting has started', 'locked');
      if (b.opens_at !== undefined && !sameInstant(b.opens_at, cur.opens_at)) throw new HttpError(409, 'The opening time cannot be changed once voting has started', 'locked');
      const changes: EditChange[] = [];
      if (b.title !== undefined && b.title !== cur.title) changes.push({ what: 'title', from: cur.title, to: b.title });
      if (b.description !== undefined && (b.description ?? null) !== (cur.description ?? null)) changes.push({ what: 'description', from: trunc(cur.description), to: trunc(b.description) });
      if (b.closes_at !== undefined && !sameInstant(b.closes_at, cur.closes_at)) {
        if (b.closes_at !== null && new Date(b.closes_at) <= cur.db_now!) throw new HttpError(400, 'The new closing time must be in the future', 'bad_window');
        if (b.closes_at !== null && cur.opens_at && new Date(b.closes_at) <= cur.opens_at) throw new HttpError(400, 'closes_at must be after opens_at');
        changes.push({ what: 'closes_at', from: cur.closes_at ? cur.closes_at.toISOString() : null, to: b.closes_at });
      }
      if (!changes.length) return cur;   // nothing changed: nothing to record
      const { rows } = await tx.query(
        `UPDATE campaigns SET
           title = CASE WHEN $2::boolean THEN $3 ELSE title END,
           description = CASE WHEN $4::boolean THEN $5 ELSE description END,
           closes_at = CASE WHEN $6::boolean THEN $7::timestamptz ELSE closes_at END
         WHERE id = $1 RETURNING *`,
        [c.id, changes.some((x) => x.what === 'title'), b.title ?? null, changes.some((x) => x.what === 'description'), b.description ?? null,
         changes.some((x) => x.what === 'closes_at'), b.closes_at ?? null]);
      await auditEdit(tx, actor, c.id, changes);
      return rows[0] as CampaignRow;
    });
    res.json(present(updated));
  });

  r.post('/:id/candidates', loadRunnable, upload.single('photo'), async (req, res) => {
    const c = camp(res);
    const b = candidateBody.parse({ name: req.body?.name, ...(req.body?.bio !== undefined ? { bio: req.body.bio } : {}) });
    const photo = req.file ? await savePhoto(req.file.buffer) : null;
    try {
      const cand = await inEditTx(c.id, async (tx, live) => {
        if (live) await requireNoVotes(tx, c.id);
        const { rows } = await tx.query(
          `INSERT INTO candidates (campaign_id, name, bio, photo_path, sort_order)
           VALUES ($1,$2,$3,$4,(SELECT COALESCE(max(sort_order),0)+1 FROM candidates WHERE campaign_id = $1 AND NOT is_abstain))
           RETURNING id, name, bio, photo_path, sort_order`, [c.id, b.name, b.bio || null, photo]);
        if (live) {
          await tx.query('INSERT INTO tallies (campaign_id, candidate_id, votes) VALUES ($1, $2, 0)', [c.id, rows[0].id]);   // a started campaign has a counter per candidate
          await auditEdit(tx, currentUser(req).oid, c.id, [{ what: 'candidate_added', name: b.name }]);
        } else await audit(tx, currentUser(req).oid, 'candidate.add', c.id, { candidate_id: rows[0].id });
        return rows[0];
      });
      res.status(201).json({ ...cand, photo_url: photoUrl(cand), photo_path: undefined });
    } catch (e) { await deletePhoto(photo); throw e; }
  });

  r.patch('/:id/candidates/:cid', loadRunnable, upload.single('photo'), async (req, res) => {
    const c = camp(res);
    const { cid } = candParams.parse(req.params);
    const b = candidatePatchBody.parse({
      ...(req.body?.name !== undefined ? { name: req.body.name } : {}),
      ...(req.body?.bio !== undefined ? { bio: req.body.bio } : {}),
      ...(req.body?.removePhoto !== undefined ? { removePhoto: req.body.removePhoto } : {}),
    });
    const newPhoto = req.file ? await savePhoto(req.file.buffer) : null;
    try {
      const { cand, oldPhoto } = await inEditTx(c.id, async (tx, live) => {
        if (live) await requireNoVotes(tx, c.id);
        const old = await tx.query('SELECT name, photo_path FROM candidates WHERE id = $1 AND campaign_id = $2 AND NOT is_abstain FOR UPDATE', [cid, c.id]);
        if (!old.rowCount) throw notFound();
        const setPhoto = newPhoto !== null || b.removePhoto === 'true';
        const { rows } = await tx.query(
          `UPDATE candidates SET name = COALESCE($3, name),
             bio = CASE WHEN $4::boolean THEN NULLIF($5, '') ELSE bio END,
             photo_path = CASE WHEN $6::boolean THEN $7 ELSE photo_path END
           WHERE id = $1 AND campaign_id = $2 RETURNING id, name, bio, photo_path, sort_order`,
          [cid, c.id, b.name ?? null, b.bio !== undefined, b.bio ?? null, setPhoto, newPhoto]);
        if (live) {
          const oldName = old.rows[0].name as string;
          await auditEdit(tx, currentUser(req).oid, c.id, [{ what: 'candidate_edited', name: rows[0].name, ...(rows[0].name !== oldName ? { from: oldName, to: rows[0].name as string } : {}) }]);
        } else await audit(tx, currentUser(req).oid, 'candidate.update', c.id, { candidate_id: cid });
        return { cand: rows[0], oldPhoto: setPhoto ? (old.rows[0].photo_path as string | null) : null };
      });
      await deletePhoto(oldPhoto);
      res.json({ ...cand, photo_url: photoUrl(cand), photo_path: undefined });
    } catch (e) { await deletePhoto(newPhoto); throw e; }
  });

  r.delete('/:id/candidates/:cid', loadRunnable, async (req, res) => {
    const c = camp(res);
    const { cid } = candParams.parse(req.params);
    const photo = await inEditTx(c.id, async (tx, live) => {
      if (live) {
        await requireNoVotes(tx, c.id);
        const n = (await tx.query('SELECT count(*)::int AS n FROM candidates WHERE campaign_id = $1 AND NOT is_abstain', [c.id])).rows[0].n as number;
        if (n <= 2) throw new HttpError(409, 'A running vote needs at least 2 candidates', 'needs_candidates');
      }
      const { rows } = await tx.query('DELETE FROM candidates WHERE id = $1 AND campaign_id = $2 AND NOT is_abstain RETURNING name, photo_path', [cid, c.id]);
      if (!rows.length) throw notFound();
      if (live) await auditEdit(tx, currentUser(req).oid, c.id, [{ what: 'candidate_removed', name: rows[0].name as string }]);
      else await audit(tx, currentUser(req).oid, 'candidate.delete', c.id, { candidate_id: cid });
      return rows[0].photo_path as string | null;
    });
    await deletePhoto(photo);
    res.status(204).end();
  });

  r.put('/:id/eligible', loadRunnable, async (req, res) => {
    const c = camp(res);
    const b = eligibleBody.parse(req.body);
    let emails: string[] = [];
    if (b.mode === 'list') emails = cleanEmails(b.emails);
    await inDraftTx(c.id, async (tx) => {
      await tx.query('UPDATE campaigns SET eligibility = $2 WHERE id = $1', [c.id, b.mode]);
      await tx.query('DELETE FROM eligible_voters WHERE campaign_id = $1', [c.id]);
      if (emails.length) await tx.query('INSERT INTO eligible_voters (campaign_id, voter_email) SELECT $1, unnest($2::text[])', [c.id, emails]);
      await audit(tx, currentUser(req).oid, 'eligibility.set', c.id, { mode: b.mode, count: emails.length });
    });
    res.json({ mode: b.mode, count: emails.length });
  });

  r.post('/:id/start', loadRunnable, async (req, res) => {
    const c = camp(res);
    await inDraftTx(c.id, async (tx) => {
      const n = (await tx.query('SELECT count(*)::int AS n FROM candidates WHERE campaign_id = $1 AND NOT is_abstain', [c.id])).rows[0].n;
      if (n < 2) throw new HttpError(409, 'At least 2 candidates are required to start', 'needs_candidates');
      const fresh = (await tx.query('SELECT eligibility, closes_at, (closes_at <= clock_timestamp()) AS closes_in_past FROM campaigns WHERE id = $1', [c.id])).rows[0];
      if (fresh.eligibility === 'umoja' && (await activeMemberCount(tx)) < 1) {
        throw new HttpError(409, 'There are no active Umoja members loaded (run the Umoja import first)', 'needs_voters');
      }
      if (fresh.eligibility === 'list') {
        const e = (await tx.query('SELECT count(*)::int AS n FROM eligible_voters WHERE campaign_id = $1', [c.id])).rows[0].n;
        if (e < 1) throw new HttpError(409, 'The eligible voter list is empty', 'needs_voters');
      }
      if (fresh.closes_in_past) throw new HttpError(409, 'closes_at is in the past', 'bad_window');
      await tx.query("UPDATE campaigns SET status = 'open' WHERE id = $1", [c.id]);
      await createTallies(tx, c.id);                                  // one counter per candidate (SEC-02)
      const frozen = fresh.eligibility === 'umoja' ? await snapshotVoters(tx, c.id) : 0;   // the voter list is frozen now (SEC-05)
      await audit(tx, currentUser(req).oid, 'campaign.start', c.id, { candidates: n, ...(fresh.eligibility === 'umoja' ? { frozen_members: frozen } : {}) });
    });
    res.json({ status: 'open' });
  });

  /**
   * Closing before the planned closing time needs a reason (>= 10 characters). It is recorded in the sealed audit entry and shown
   * to voters on the ballot page and in the published results (SEC-01).
   */
  r.post('/:id/close', loadRunnable, async (req, res) => {
    const c = camp(res);
    const b = closeBody.parse(req.body ?? {});
    const integrity = await withTx(async (tx) => {
      const { rows } = await tx.query('SELECT status, (closes_at > clock_timestamp()) AS early FROM campaigns WHERE id = $1 FOR UPDATE', [c.id]);
      if (rows[0]?.status !== 'open') throw new HttpError(409, 'Only an open campaign can be closed', 'not_open');
      const early = rows[0].early === true;   // before the planned closing time, by the database clock (SEC-18)
      if (early && !b.reason) throw new HttpError(400, 'Closing before the planned closing time needs a reason of at least 10 characters', 'reason_required');
      return closeInTx(tx, c.id, currentUser(req).oid, 'manual', early ? { early: true, why: b.reason } : {});
    }).catch(async (e) => {
      if (e instanceof IntegrityBlocked) {   // SEC-16: receipts != tallies: not closed, recorded, and the admin is told why
        await recordIntegrityBlock(c.id, currentUser(req).oid, e, 'manual');
        throw new HttpError(409, integrityMessage(e), 'integrity_mismatch');
      }
      throw e;
    });
    res.json({ status: 'closed', integrity });
  });

  // ---- Clean-up -------------------------------------------------------------------------------------------------

  /** Draft: hard delete (campaign, candidates, eligibility rows) and its photo files. Creator only. */
  r.delete('/:id', loadOwned, async (req, res) => {
    const c = camp(res);
    const out = await callCleanup('SELECT delete_draft_campaign($1, $2) AS result', [c.id, sessionRawId(req)],
      (status) => status === 'open'
        ? { message: 'Close the campaign first', code: 'open_campaign' }
        : { message: 'Only a draft can be deleted. Archive a closed campaign instead.', code: 'not_draft' }, c.id);
    await removePhotos(out.photos);
    res.status(204).end();
  });

  /** Closed -> archived. Open campaigns must be closed first; drafts are deleted, not archived. */
  r.post('/:id/archive', loadOwned, async (req, res) => {
    const c = camp(res);
    await withTx(async (tx) => {
      const { rows } = await tx.query('SELECT status, archived_at, title FROM campaigns WHERE id = $1 FOR UPDATE', [c.id]);
      const f = rows[0];
      if (f.status === 'open') throw new HttpError(409, 'Close the campaign first', 'open_campaign');
      if (f.status !== 'closed') throw new HttpError(409, 'Only a closed campaign can be archived', 'not_closed');
      if (f.archived_at) throw new HttpError(409, 'Already archived', 'already_archived');
      await tx.query('UPDATE campaigns SET archived_at = now() WHERE id = $1', [c.id]);
      await audit(tx, currentUser(req).oid, 'campaign.archive', c.id, { title: f.title });
    });
    res.json({ archived: true });
  });

  r.post('/:id/unarchive', loadOwned, async (req, res) => {
    const c = camp(res);
    await withTx(async (tx) => {
      const { rows } = await tx.query('SELECT archived_at, title FROM campaigns WHERE id = $1 FOR UPDATE', [c.id]);
      if (!rows[0].archived_at) throw new HttpError(409, 'The campaign is not archived', 'not_archived');
      await tx.query('UPDATE campaigns SET archived_at = NULL WHERE id = $1', [c.id]);
      await audit(tx, currentUser(req).oid, 'campaign.unarchive', c.id, { title: rows[0].title });
    });
    res.json({ archived: false });
  });

  /** Archived only: removes ballots, receipts, candidates, eligibility and the campaign for good. Needs the exact title. */
  r.post('/:id/permanent-delete', loadOwned, async (req, res) => {
    const c = camp(res);
    const b = permanentDeleteBody.parse(req.body);
    if (c.require_approval) throw new HttpError(409, 'This campaign needs a co-admin\'s approval to be deleted. Request it in the Team tab.', 'approval_required');
    res.json(await doPermanentDelete(req, c, b.confirm_title));
  });

  async function doPermanentDelete(req: Request, c: CampaignRow, confirmTitle: string) {
    if (!c.archived_at || c.status !== 'closed') throw new HttpError(409, 'Archive the campaign first. Only archived campaigns can be deleted permanently.', 'not_archived');
    if (confirmTitle !== c.title) throw new HttpError(400, 'The title you typed does not match', 'title_mismatch');
    // A permanent delete destroys the only copy of the counters and receipts, so a CSV of the sealed result must have been
    // downloaded after the campaign closed (SEC-04). The sealed entry itself stays in the audit log.
    const exported = await getPool().query(
      `SELECT 1 FROM audit_log WHERE campaign_id = $1 AND action IN ('results.export_csv', 'results.export_xlsx', 'results.export_pdf')
          AND seq > coalesce((SELECT max(seq) FROM audit_log WHERE campaign_id = $1 AND action LIKE 'campaign.close%'), 0) LIMIT 1`, [c.id]);
    if (!exported.rowCount) throw new HttpError(409, 'Export the results (CSV, Excel or PDF) before deleting permanently, so a copy of the result exists outside the system.', 'export_first');
    const out = await callCleanup('SELECT delete_archived_campaign($1, $2) AS result', [c.id, sessionRawId(req)],
      () => ({ message: 'Archive the campaign first. Only archived campaigns can be deleted permanently.', code: 'not_archived' }), c.id);
    await removePhotos(out.photos);
    return { deleted: true, ballots_removed: out.ballots, receipts_removed: out.receipts };
  }

  /** Open or closed (not archived): wipes all votes and re-opens the voting. Needs the exact title and a reason. */
  r.post('/:id/reset', loadOwned, async (req, res) => {
    const c = camp(res);
    const b = resetBody.parse(req.body);
    if (c.require_approval) throw new HttpError(409, 'This campaign needs a co-admin\'s approval to be reset. Request it in the Team tab.', 'approval_required');
    res.json(await doReset(req, c, b));
  });

  async function doReset(req: Request, c: CampaignRow, b: { confirm_title: string; reason: string; closes_at?: string | null }) {
    if (c.archived_at) throw new HttpError(409, 'Unarchive the campaign before resetting it', 'archived');
    if (c.status === 'draft') throw new HttpError(409, 'A draft has no votes to reset', 'not_started');
    if (b.confirm_title !== c.title) throw new HttpError(400, 'The title you typed does not match', 'title_mismatch');
    const out = await callCleanup('SELECT reset_campaign_votes($1, $2, $3, $4) AS result', [c.id, sessionRawId(req), b.reason, b.closes_at ?? null],
      (status, archived) => archived ? { message: 'Unarchive the campaign before resetting it', code: 'archived' }
        : status === 'draft' ? { message: 'A draft has no votes to reset', code: 'not_started' } : { message: 'This campaign cannot be reset right now', code: 'conflict' }, c.id);
    return { status: 'open', votes_cleared: out.votes_cleared };
  }

  // Team (co-admins, observers) and the second-approver flow
  r.use('/:id', teamRouter({ loadOwned, loadRunnable, camp, shouldAuditDenied, doReset, doPermanentDelete }));

  /**
   * SEC-01: while a campaign is open (or still a draft) the creator sees ONLY turnout. Per-candidate counts exist in this
   * response only once the campaign is closed, and the counts of reset rounds are likewise held back until then.
   */
  r.get('/:id/results', loadRunnable, async (_req, res) => {
    const c = camp(res);
    const closed = c.status === 'closed';
    res.set('Cache-Control', 'no-store');
    res.json({
      status: c.status, results_published: c.results_published, archived: !!c.archived_at,
      ...(closed ? await getResults(getPool(), c.id) : { candidates: null, turnout: await getTurnout(getPool(), c.id) }),
      ...(closed ? { runoff: await runoffInfo(c) } : {}),
      resets: (await getNotices(getPool(), c.id, closed)).filter((n) => n.kind === 'reset'),
      notices: await getNotices(getPool(), c.id, closed),
    });
  });

  /** "Verify results integrity" (SEC-04): audit chain intact, result sealed at close, counters and receipts unchanged since. */
  r.get('/:id/verify', loadRunnable, async (_req, res) => {
    res.set('Cache-Control', 'no-store').json(await verifySeal(getPool(), camp(res).id));
  });

  /**
   * SEC-16: "I investigated": lifts the integrity block so the campaign can be closed (the sealed entry then records that the
   * mismatch was acknowledged, and by whom). Needs a note of at least 10 characters.
   */
  r.post('/:id/integrity/acknowledge', loadRunnable, async (req, res) => {
    const c = camp(res);
    const b = ackBody.parse(req.body);
    await withTx(async (tx) => {
      const { rows } = await tx.query('SELECT status FROM campaigns WHERE id = $1 FOR UPDATE', [c.id]);
      if (rows[0]?.status !== 'open') throw new HttpError(409, 'Only an open campaign can have an integrity block', 'not_open');
      const block = await openIntegrityBlock(tx, c.id);
      if (!block) throw new HttpError(409, 'There is no integrity problem to acknowledge', 'no_integrity_block');
      await audit(tx, currentUser(req).oid, 'campaign.integrity.ack', c.id, { note: b.note, ballots: block.ballots, receipts: block.receipts });
    });
    res.json({ acknowledged: true });
  });

  r.post('/:id/publish', loadRunnable, async (req, res) => {
    const c = camp(res);
    await withTx(async (tx) => {
      const { rows } = await tx.query('SELECT status FROM campaigns WHERE id = $1 FOR UPDATE', [c.id]);
      if (rows[0]?.status !== 'closed') throw new HttpError(409, 'Results can only be published after the campaign is closed', 'not_closed');
      // SEC-16: a result that no longer matches its seal (changed counters, receipts, or audit chain) is not published.
      const seal = await verifySeal(tx, c.id);
      if (seal.sealed && (!seal.chain_ok || seal.tallies_match === false || seal.receipts_match === false)) {
        throw new HttpError(409, 'The result no longer matches what was sealed when the campaign closed. Run "Verify results integrity" and investigate before publishing.', 'integrity_failed');
      }
      await tx.query('UPDATE campaigns SET results_published = true WHERE id = $1', [c.id]);
      await audit(tx, currentUser(req).oid, 'results.publish', c.id);
    });
    res.json({ results_published: true });
  });

  r.get('/:id/qr.png', loadRunnable, async (req, res) => {
    const png = await QRCode.toBuffer(shareUrl(camp(res).share_token), { type: 'png', width: 640, margin: 2, errorCorrectionLevel: 'M' });
    if (req.query.download === '1') await audit(getPool(), currentUser(req).oid, 'qr.download', camp(res).id);   // previews are not audited
    res.type('png').set('Cache-Control', 'private, no-store').set('Content-Disposition', req.query.download === '1' ? 'attachment; filename="voting-qr.png"' : 'inline').send(png);
  });

  r.get('/:id/poster.pdf', loadRunnable, async (req, res) => {
    const c = camp(res);
    const url = shareUrl(c.share_token);
    const png = await QRCode.toBuffer(url, { type: 'png', width: 900, margin: 1, errorCorrectionLevel: 'M' });
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (d: Buffer) => chunks.push(d)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    });
    const w = doc.page.width - 100;
    doc.font('Helvetica-Bold').fontSize(34).text(c.title, 50, 80, { width: w, align: 'center' });
    doc.moveDown(0.6).font('Helvetica').fontSize(20).fillColor('#333')
      .text('Scan the QR code with your phone to cast your vote.', { width: w, align: 'center' });
    doc.image(png, (doc.page.width - 360) / 2, 300, { width: 360 });
    doc.fillColor('#555').fontSize(14).text('Your vote is secret. You can vote once, using your NamRA sign-in.', 50, 690, { width: w, align: 'center' });
    doc.fontSize(11).fillColor('#777').text(url, 50, 730, { width: w, align: 'center' });
    doc.end();
    const pdf = await done;
    await audit(getPool(), currentUser(req).oid, 'poster.download', c.id);
    res.type('application/pdf').set('Content-Disposition', 'attachment; filename="poster.pdf"').set('Cache-Control', 'private, no-store').send(pdf);
  });

  /**
   * Tie rule: a tie for first place goes to a run-off. This clones the tied candidates (with their photos) and the voter list into a
   * NEW draft campaign linked to this one. The run-off is started like any campaign, so it gets its own frozen voter snapshot and
   * its own seal. At most MAX_RUNOFFS (default 2) rounds follow one campaign.
   */
  r.post('/:id/runoff', loadRunnable, async (req, res) => {
    const c = camp(res);
    const u = currentUser(req);
    if (c.status !== 'closed') throw new HttpError(409, 'A run-off can only follow a closed campaign', 'not_closed');
    if (c.archived_at) throw new HttpError(409, 'Unarchive the campaign before starting a run-off', 'archived');
    const results = await getResults(getPool(), c.id);
    if (!results.tie) throw new HttpError(409, 'There is no tie for first place', 'no_tie');
    const max = getConfig().maxRunoffs;
    if ((c.runoff_round ?? 0) >= max) throw new HttpError(409, `The limit of ${max} run-off round${max === 1 ? '' : 's'} has been reached. Decide the tie another way.`, 'runoff_limit');
    const tied = (await getPool().query('SELECT name, bio, photo_path FROM candidates WHERE id = ANY($1::uuid[]) ORDER BY sort_order, name', [results.tie.ids])).rows;
    // Photo files are copied first (a new file per candidate), so deleting one campaign can never delete the other's photos.
    const photos: (string | null)[] = [];
    for (const t of tied) { const buf = t.photo_path ? await readPhoto(t.photo_path) : null; photos.push(buf ? await savePhoto(buf) : null); }
    const token = crypto.randomBytes(24).toString('base64url');
    const round = (c.runoff_round ?? 0) + 1;
    const title = `${c.title.replace(/ \(run-off \d+\)$/, '')} (run-off ${round})`.slice(0, 200);
    try {
      const created = await withTx(async (tx) => {
        const lock = await tx.query('SELECT 1 FROM campaigns WHERE id = $1 FOR UPDATE', [c.id]);
        if (!lock.rowCount) throw notFound();
        if ((await tx.query('SELECT 1 FROM campaigns WHERE parent_campaign_id = $1 LIMIT 1', [c.id])).rowCount) throw new HttpError(409, 'A run-off has already been started for this campaign', 'runoff_exists');
        const { rows } = await tx.query(
          `INSERT INTO campaigns (share_token, created_by, title, description, eligibility, allow_edits_after_start, parent_campaign_id, runoff_round)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [token, u.oid, title, c.description, c.eligibility, c.allow_edits_after_start === true, c.id, round]);
        const id = rows[0].id as string;
        for (let i = 0; i < tied.length; i++) {
          await tx.query('INSERT INTO candidates (campaign_id, name, bio, photo_path, sort_order) VALUES ($1,$2,$3,$4,$5)', [id, tied[i].name, tied[i].bio, photos[i], i + 1]);
        }
        if (c.eligibility === 'list') await tx.query('INSERT INTO eligible_voters (campaign_id, voter_email) SELECT $1, voter_email FROM eligible_voters WHERE campaign_id = $2', [id, c.id]);
        await audit(tx, u.oid, 'campaign.runoff_created', c.id, { runoff_id: id, round, tied: results.tie!.names, votes_each: results.tie!.votes });
        await audit(tx, u.oid, 'campaign.create', id, { title, eligibility: c.eligibility, runoff_of: c.id, round });
        return rows[0] as CampaignRow;
      });
      res.status(201).json(present(created));
    } catch (e) { await removePhotos(photos.filter(Boolean)); throw e; }
  });

  r.get('/:id/results.csv', loadRunnable, async (req, res) => {
    const c = camp(res);
    if (c.status !== 'closed') throw new HttpError(409, 'CSV export is only available after the campaign is closed', 'not_closed');
    const results = await getResults(getPool(), c.id);
    const seal = await verifySeal(getPool(), c.id);   // the fingerprint ties this file to the sealed audit entry (SEC-04)
    const abstain = results.candidates.find((x) => x.is_abstain);
    const lines = ['candidate,votes', ...results.candidates.filter((x) => !x.is_abstain).map((x) => `${csvCell(x.name)},${x.votes}`),
      ...(abstain ? [`Abstentions (not a candidate),${abstain.votes}`] : []), `Total ballots,${results.turnout.votes}`,
      ...(results.tie ? [`Tie,${csvCell('YES: tie for first place between ' + results.tie.names.join(' and '))}`] : []),
      ...(c.runoff_round ? [`Run-off round,${c.runoff_round}`] : []),
      ...(seal.sealed && seal.seal_hash ? [`Sealed at,${new Date(seal.sealed_at!).toISOString()}`, `Seal fingerprint,${seal.seal_hash}`] : [])];
    await audit(getPool(), currentUser(req).oid, 'results.export_csv', c.id);
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="results.csv"').set('Cache-Control', 'private, no-store').send(lines.join('\r\n') + '\r\n');
  });

  /**
   * Excel and PDF exports. Same rules as the CSV (SEC-01): the creator only (loadOwned answers 404 to anyone else) and only once
   * the campaign is closed; each download is audited.
   */
  const exportRoute = (kind: 'xlsx' | 'pdf'): RequestHandler => async (req, res) => {
    const c = camp(res);
    if (c.status !== 'closed') throw new HttpError(409, 'Exports are only available after the campaign is closed', 'not_closed');
    const u = currentUser(req);
    const data = await gatherExport(getPool(), c, `${u.displayName} (${u.email})`);
    const file = kind === 'xlsx' ? await buildXlsx(data) : await buildPdf(data);
    await audit(getPool(), u.oid, `results.export_${kind}`, c.id);
    res.type(kind === 'xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf')
      .set('Content-Disposition', `attachment; filename="results.${kind}"`).set('Cache-Control', 'private, no-store').send(file);
  };
  r.get('/:id/results.xlsx', loadRunnable, exportRoute('xlsx'));
  r.get('/:id/results.pdf', loadRunnable, exportRoute('pdf'));

  return r;
}

export { ADMIN_ROLE };
