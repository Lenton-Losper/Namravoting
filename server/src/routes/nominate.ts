import { Router, type Request } from 'express';
import multer from 'multer';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { getConfig } from '../config.js';
import { getPool, withTx } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { currentUser, getCurrentUser, requireUser, type AuthUser } from '../auth/index.js';
import { clientIp } from '../auth/limits.js';
import { profileBody, tokenParams } from '../domain/validation.js';
import { audit } from '../services/audit.js';
import type { CampaignRow } from '../services/campaigns.js';
import { deletePhoto, MAX_UPLOAD_BYTES, savePhoto } from '../services/images.js';
import { nominationState } from '../services/positions.js';
import { logNotMember, umojaStanding } from '../services/umoja.js';

/**
 * Candidate self-nomination. A candidate opens the position's link, signs in with Microsoft and fills in their own profile (name, photo,
 * short bio, region). One profile per person per position; they can edit it until the admin approves it, or until the campaign starts.
 * The admin then approves or rejects it (routes/positions.ts); only APPROVED candidates reach the ballot.
 *
 * The token in the link identifies one position. It stops working when the campaign starts, when the optional deadline passes, when the admin
 * closes nominations for the position, or when the admin revokes the link. Unknown and malformed tokens answer the same 404.
 */

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 6, fieldSize: 4096 } });

interface Ctx {
  campaign: CampaignRow & { db_now: Date };
  position: { id: string; title: string; description: string | null; status: 'open' | 'closed'; invite_token: string | null };
}

async function load(req: Request): Promise<Ctx> {
  const p = tokenParams.safeParse(req.params);
  if (!p.success) throw notFound();
  const row = (await getPool().query(
    `SELECT p.id AS pid, p.title AS ptitle, p.description AS pdesc, p.status AS pstatus, p.invite_token, c.*, clock_timestamp() AS db_now
       FROM positions p JOIN campaigns c ON c.id = p.campaign_id WHERE p.invite_token = $1`, [p.data.shareToken])).rows[0];
  if (!row) throw notFound();
  return { campaign: row, position: { id: row.pid, title: row.ptitle, description: row.pdesc, status: row.pstatus, invite_token: row.invite_token } };
}

/** Same eligibility rule as voting unless the campaign sets its own for nominations (all staff, or Umoja members only). */
async function mayNominate(c: CampaignRow, u: AuthUser): Promise<{ ok: boolean; notMember: boolean }> {
  const mode = c.nominate_eligibility ?? c.eligibility;
  if (mode === 'all') return { ok: true, notMember: false };
  if (mode === 'umoja') {
    const s = await umojaStanding(getPool(), u.oid, { id: c.id, status: c.status });
    if (s.reason !== 'member') { logNotMember(s.reason, c.id, u.oid); return { ok: false, notMember: true }; }
    return { ok: true, notMember: false };
  }
  const listed = (await getPool().query('SELECT 1 FROM eligible_voters WHERE campaign_id = $1 AND voter_email = $2', [c.id, u.email.toLowerCase()])).rowCount! > 0;
  return { ok: listed, notMember: false };
}

const profileOut = (k: Record<string, unknown> | undefined) => (k ? {
  id: k.id, name: k.name, bio: k.bio, regionId: k.region_id, status: k.status, reviewReason: k.status === 'rejected' ? k.review_reason : null,
  photoUrl: k.photo_path ? `/api/photos/${k.id}` : null, submittedAt: k.submitted_at,
} : null);

export function nominateRouter(): Router {
  const r = Router();
  r.use(requireUser);

  const key = (req: Request) => getCurrentUser(req)?.oid ?? ipKeyGenerator(clientIp(req));
  const readLimiter = rateLimit({ windowMs: 60_000, limit: getConfig().readRateLimit, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: key, message: { error: 'Too many requests' } });
  const writeLimiter = rateLimit({ windowMs: 60_000, limit: getConfig().voteRateLimit, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: key, message: { error: 'Too many requests' } });

  r.get('/:shareToken', readLimiter, async (req, res) => {
    const { campaign: c, position: p } = await load(req);
    const u = currentUser(req);
    const may = await mayNominate(c, u);
    if (may.notMember) throw new HttpError(403, 'Nominations for this vote are for Umoja members only', 'not_member');
    if (!may.ok) throw new HttpError(403, 'You are not eligible to nominate yourself in this campaign', 'not_eligible');
    const state = nominationState(c, p, c.db_now);
    const mine = (await getPool().query(
      `SELECT id, name, bio, region_id, status, review_reason, photo_path, submitted_at FROM candidates WHERE position_id = $1 AND submitted_by_oid = $2`, [p.id, u.oid])).rows[0];
    const regions = (await getPool().query('SELECT id, name FROM regions WHERE campaign_id = $1 ORDER BY sort_order, name', [c.id])).rows;
    res.set('Cache-Control', 'no-store').json({
      campaign: { title: c.title }, position: { id: p.id, title: p.title, description: p.description },
      state, closesAt: c.nominations_close_at ?? null, regions, defaultName: u.displayName,
      profile: profileOut(mine),
      // A profile can be edited until the admin approves it, while nominations are open.
      canEdit: state === 'open' && mine?.status !== 'approved',
    });
  });

  /** Create or update my profile (always back to "submitted" for review). */
  r.put('/:shareToken', writeLimiter, upload.single('photo'), async (req, res) => {
    const ctx = await load(req);
    const u = currentUser(req);
    const b = profileBody.parse({ name: req.body?.name, ...(req.body?.bio !== undefined ? { bio: req.body.bio } : {}), region_id: req.body?.region_id });
    const removePhoto = z.enum(['true', 'false']).optional().parse(req.body?.removePhoto) === 'true';
    const may = await mayNominate(ctx.campaign, u);
    if (!may.ok) throw new HttpError(403, may.notMember ? 'Nominations for this vote are for Umoja members only' : 'You are not eligible to nominate yourself in this campaign', may.notMember ? 'not_member' : 'not_eligible');
    const newPhoto = req.file ? await savePhoto(req.file.buffer) : null;
    try {
      const { oldPhoto, id, resubmitted } = await withTx(async (tx) => {
        // The campaign row lock serialises this with the admin starting the campaign: no profile slips in (or changes) after the start.
        const camp = (await tx.query('SELECT status, nominations_close_at, clock_timestamp() AS now FROM campaigns WHERE id = $1 FOR UPDATE', [ctx.campaign.id])).rows[0];
        const pos = (await tx.query('SELECT id, status, invite_token FROM positions WHERE id = $1', [ctx.position.id])).rows[0];
        if (!pos || pos.invite_token !== ctx.position.invite_token) throw notFound();   // the link was revoked meanwhile
        const state = nominationState(camp, pos, camp.now);
        if (state !== 'open') throw new HttpError(409, state === 'ended' ? 'Nominations closed when voting started' : 'Nominations for this position are closed', 'nominations_closed');
        if (!(await tx.query('SELECT 1 FROM regions WHERE id = $1 AND campaign_id = $2', [b.region_id, ctx.campaign.id])).rowCount) throw new HttpError(400, 'Choose a region from the list', 'invalid_region');
        const mine = (await tx.query('SELECT id, status, photo_path FROM candidates WHERE position_id = $1 AND submitted_by_oid = $2 FOR UPDATE', [pos.id, u.oid])).rows[0];
        if (mine?.status === 'approved') throw new HttpError(409, 'Your profile has been approved, so it can no longer be changed. Ask the campaign administrator if something must be corrected.', 'locked_approved');
        if (mine) {
          const setPhoto = newPhoto !== null || removePhoto;
          await tx.query(
            `UPDATE candidates SET name = $2, bio = $3, region_id = $4, photo_path = CASE WHEN $5::boolean THEN $6 ELSE photo_path END,
                    status = 'submitted', submitted_at = now(), review_reason = NULL, reviewed_by = NULL, reviewed_at = NULL
              WHERE id = $1`, [mine.id, b.name, b.bio || null, b.region_id, setPhoto, newPhoto]);
          await audit(tx, u.oid, 'nomination.submit', ctx.campaign.id, { candidate_id: mine.id, position_id: pos.id, resubmitted: true });
          return { oldPhoto: setPhoto ? (mine.photo_path as string | null) : null, id: mine.id as string, resubmitted: true };
        }
        const ins = (await tx.query(
          `INSERT INTO candidates (campaign_id, position_id, region_id, name, bio, photo_path, status, submitted_by_oid, submitted_at, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,'submitted',$7,now(),(SELECT COALESCE(max(sort_order), 0) + 1 FROM candidates WHERE position_id = $2 AND NOT is_abstain)) RETURNING id`,
          [ctx.campaign.id, pos.id, b.region_id, b.name, b.bio || null, newPhoto, u.oid])).rows[0];
        await audit(tx, u.oid, 'nomination.submit', ctx.campaign.id, { candidate_id: ins.id, position_id: pos.id, resubmitted: false });
        return { oldPhoto: null, id: ins.id as string, resubmitted: false };
      });
      await deletePhoto(oldPhoto);
      const row = (await getPool().query('SELECT id, name, bio, region_id, status, review_reason, photo_path, submitted_at FROM candidates WHERE id = $1', [id])).rows[0];
      res.status(resubmitted ? 200 : 201).json({ profile: profileOut(row) });
    } catch (e) { await deletePhoto(newPhoto); throw e; }
  });

  /** "I am not standing after all": allowed while nominations are open (after the start the administrator does it). */
  r.post('/:shareToken/withdraw', writeLimiter, async (req, res) => {
    const ctx = await load(req);
    const u = currentUser(req);
    await withTx(async (tx) => {
      const camp = (await tx.query('SELECT status, nominations_close_at, clock_timestamp() AS now FROM campaigns WHERE id = $1 FOR UPDATE', [ctx.campaign.id])).rows[0];
      const state = nominationState(camp, ctx.position, camp.now);
      if (state === 'ended') throw new HttpError(409, 'Voting has started. Ask the campaign administrator to withdraw you.', 'nominations_closed');
      const mine = (await tx.query('SELECT id, status FROM candidates WHERE position_id = $1 AND submitted_by_oid = $2 FOR UPDATE', [ctx.position.id, u.oid])).rows[0];
      if (!mine) throw notFound();
      if (mine.status === 'withdrawn') throw new HttpError(409, 'You have already withdrawn', 'already_withdrawn');
      await tx.query("UPDATE candidates SET status = 'withdrawn' WHERE id = $1", [mine.id]);
      await audit(tx, u.oid, 'nomination.withdraw', ctx.campaign.id, { candidate_id: mine.id, position_id: ctx.position.id });
    });
    res.json({ status: 'withdrawn' });
  });

  return r;
}
