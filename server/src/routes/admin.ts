import crypto from 'node:crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import multer from 'multer';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { PoolClient } from 'pg';
import { getConfig } from '../config.js';
import { getPool, withTx } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { ADMIN_ROLE, currentUser, getCurrentUser, isAdmin, requireUser } from '../auth/index.js';
import { normalizeEmail } from '../domain/eligibility.js';
import {
  candParams, candidateBody, candidatePatchBody, createCampaignBody, eligibleBody, idParams, patchCampaignBody,
} from '../domain/validation.js';
import { audit } from '../services/audit.js';
import { closeInTx, getResults, refreshStatus, type CampaignRow } from '../services/campaigns.js';
import { deletePhoto, MAX_UPLOAD_BYTES, savePhoto } from '../services/images.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5, fieldSize: 4096 } });

/** Admin gate: role check; failures are audit-logged. */
const requireAdmin: RequestHandler = async (req, res, next) => {
  const u = currentUser(req);
  if (!isAdmin(u)) {
    await audit(getPool(), u.oid, 'authz.denied', null, { reason: 'not_admin', method: req.method, path: req.path });
    res.status(403).json({ error: 'Forbidden' });
    return;
  }
  next();
};

/** Per-user admin rate limit (falls back to IP if somehow unauthenticated). */
const adminLimiter = () => rateLimit({
  windowMs: 60_000, limit: getConfig().adminRateLimit, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: (req) => getCurrentUser(req as Request)?.oid ?? ipKeyGenerator(req.ip ?? ''),
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
    await audit(getPool(), u.oid, 'authz.denied', id, { reason: 'not_owner', method: req.method, path: req.path });
    next(notFound());
    return;
  }
  res.locals.campaign = c;
  next();
};
const camp = (res: Response) => res.locals.campaign as CampaignRow;

/** Runs fn in a tx holding a row lock on the campaign; rejects unless it is still a draft. */
async function inDraftTx<T>(id: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  return withTx(async (c) => {
    const { rows } = await c.query('SELECT status FROM campaigns WHERE id = $1 FOR UPDATE', [id]);
    if (rows[0]?.status !== 'draft') throw new HttpError(409, 'Campaign is locked: only drafts can be edited', 'locked');
    return fn(c);
  });
}

const shareUrl = (token: string) => `${getConfig().publicBaseUrl}/v/${token}`;
const present = (c: CampaignRow) => ({ ...c, share_url: shareUrl(c.share_token) });
const photoUrl = (cand: { id: string; photo_path: string | null }) => (cand.photo_path ? `/api/photos/${cand.id}` : null);
const csvCell = (v: string) => { const s = /^[=+\-@\t\r]/.test(v) ? "'" + v : v; return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };

export function adminRouter(): Router {
  const r = Router();
  r.use(requireUser, requireAdmin, adminLimiter());

  r.get('/mine', async (req, res) => {
    const u = currentUser(req);
    const open = await getPool().query("SELECT id FROM campaigns WHERE created_by = $1 AND status = 'open'", [u.oid]);
    for (const row of open.rows) await refreshStatus(row.id);
    const { rows } = await getPool().query(
      `SELECT c.*, (SELECT count(*)::int FROM vote_receipts v WHERE v.campaign_id = c.id) AS turnout,
              CASE WHEN c.eligibility = 'list' THEN (SELECT count(*)::int FROM eligible_voters e WHERE e.campaign_id = c.id) END AS eligible_count
         FROM campaigns c WHERE c.created_by = $1 ORDER BY c.created_at DESC`, [u.oid]);
    res.json({ campaigns: rows.map((c) => ({ ...present(c), turnout: c.turnout, eligible_count: c.eligible_count })) });
  });

  /**
   * Dashboard data, scoped to the caller's own campaigns. Receipts/ballots carry no timestamps by design,
   * so there is no "votes today" figure; `votes_open` is the total cast across open campaigns.
   */
  r.get('/summary', async (req, res) => {
    const u = currentUser(req);
    const mine = await getPool().query("SELECT id FROM campaigns WHERE created_by = $1 AND status = 'open'", [u.oid]);
    for (const row of mine.rows) await refreshStatus(row.id);
    const { rows } = await getPool().query(
      `SELECT c.id, c.title, c.status, c.created_at, c.opens_at, c.closes_at, c.eligibility, c.results_published,
              (SELECT count(*)::int FROM vote_receipts v WHERE v.campaign_id = c.id) AS turnout,
              CASE WHEN c.eligibility = 'list' THEN (SELECT count(*)::int FROM eligible_voters e WHERE e.campaign_id = c.id) END AS eligible_count,
              (SELECT min(a.at) FROM audit_log a WHERE a.campaign_id = c.id AND a.action = 'campaign.start') AS started_at,
              (SELECT max(a.at) FROM audit_log a WHERE a.campaign_id = c.id AND a.action LIKE 'campaign.close%') AS closed_at
         FROM campaigns c WHERE c.created_by = $1 ORDER BY c.created_at DESC`, [u.oid]);

    const closedIds = rows.filter((c) => c.status === 'closed').map((c) => c.id as string);
    const tallies = closedIds.length
      ? (await getPool().query(
          `SELECT c.campaign_id, c.id, c.name, c.photo_path, count(b.id)::int AS votes
             FROM candidates c LEFT JOIN ballots b ON b.candidate_id = c.id AND b.campaign_id = c.campaign_id
            WHERE c.campaign_id = ANY($1::uuid[]) GROUP BY c.id`, [closedIds])).rows
      : [];
    const winnerOf = (cid: string) => {
      const t = tallies.filter((x) => x.campaign_id === cid).sort((a, b) => b.votes - a.votes);
      if (!t.length || t[0].votes === 0) return null;
      const tie = t.length > 1 && t[1].votes === t[0].votes;
      return { id: t[0].id as string, name: t[0].name as string, votes: t[0].votes as number, tie, photo_url: t[0].photo_path ? `/api/photos/${t[0].id}` : null };
    };
    const slim = (c: (typeof rows)[number]) => ({
      id: c.id, title: c.title, status: c.status, created_at: c.created_at, opens_at: c.opens_at, closes_at: c.closes_at,
      started_at: c.started_at, closed_at: c.closed_at, results_published: c.results_published,
      turnout: c.turnout, eligible_count: c.eligible_count,
    });
    const open = rows.filter((c) => c.status === 'open');
    const drafts = rows.filter((c) => c.status === 'draft');
    const featured = open[0] ?? drafts[0] ?? null;
    res.set('Cache-Control', 'no-store').json({
      counts: { active: open.length, drafts: drafts.length, votes_open: open.reduce((n, c) => n + c.turnout, 0) },
      open: open.map(slim),
      featured: featured ? slim(featured) : null,
      closed: rows.filter((c) => c.status === 'closed').map((c) => ({ ...slim(c), winner: winnerOf(c.id) })),
    });
  });

  r.post('/', async (req, res) => {
    const u = currentUser(req);
    const b = createCampaignBody.parse(req.body);
    const token = crypto.randomBytes(24).toString('base64url');   // 32 URL-safe chars
    const created = await withTx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO campaigns (share_token, created_by, title, description, opens_at, closes_at)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [token, u.oid, b.title, b.description ?? null, b.opens_at ?? null, b.closes_at ?? null]);
      await audit(c, u.oid, 'campaign.create', rows[0].id, { title: b.title });
      return rows[0] as CampaignRow;
    });
    res.status(201).json(present(created));
  });

  r.get('/:id', loadOwned, async (_req, res) => {
    const c = camp(res);
    const cands = await getPool().query(
      'SELECT id, name, bio, photo_path, sort_order FROM candidates WHERE campaign_id = $1 ORDER BY sort_order, name', [c.id]);
    const el = await getPool().query('SELECT voter_email FROM eligible_voters WHERE campaign_id = $1 ORDER BY voter_email', [c.id]);
    res.json({
      ...present(c),
      candidates: cands.rows.map((x) => ({ id: x.id, name: x.name, bio: x.bio, photo_url: photoUrl(x), sort_order: x.sort_order })),
      eligible_emails: el.rows.map((x) => x.voter_email),
    });
  });

  r.patch('/:id', loadOwned, async (req, res) => {
    const c = camp(res);
    const b = patchCampaignBody.parse(req.body);
    const updated = await inDraftTx(c.id, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE campaigns SET
           title = CASE WHEN $2::boolean THEN $3 ELSE title END,
           description = CASE WHEN $4::boolean THEN $5 ELSE description END,
           opens_at = CASE WHEN $6::boolean THEN $7::timestamptz ELSE opens_at END,
           closes_at = CASE WHEN $8::boolean THEN $9::timestamptz ELSE closes_at END
         WHERE id = $1 RETURNING *`,
        [c.id, b.title !== undefined, b.title ?? null, b.description !== undefined, b.description ?? null,
         b.opens_at !== undefined, b.opens_at ?? null, b.closes_at !== undefined, b.closes_at ?? null]);
      const row = rows[0] as CampaignRow;
      if (row.opens_at && row.closes_at && row.closes_at <= row.opens_at) throw new HttpError(400, 'closes_at must be after opens_at');
      await audit(tx, currentUser(req).oid, 'campaign.update', c.id, { fields: Object.keys(b) });
      return row;
    });
    res.json(present(updated));
  });

  r.post('/:id/candidates', loadOwned, upload.single('photo'), async (req, res) => {
    const c = camp(res);
    const b = candidateBody.parse({ name: req.body?.name, ...(req.body?.bio !== undefined ? { bio: req.body.bio } : {}) });
    const photo = req.file ? await savePhoto(req.file.buffer) : null;
    try {
      const cand = await inDraftTx(c.id, async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO candidates (campaign_id, name, bio, photo_path, sort_order)
           VALUES ($1,$2,$3,$4,(SELECT COALESCE(max(sort_order),0)+1 FROM candidates WHERE campaign_id = $1))
           RETURNING id, name, bio, photo_path, sort_order`, [c.id, b.name, b.bio || null, photo]);
        await audit(tx, currentUser(req).oid, 'candidate.add', c.id, { candidate_id: rows[0].id });
        return rows[0];
      });
      res.status(201).json({ ...cand, photo_url: photoUrl(cand), photo_path: undefined });
    } catch (e) { await deletePhoto(photo); throw e; }
  });

  r.patch('/:id/candidates/:cid', loadOwned, upload.single('photo'), async (req, res) => {
    const c = camp(res);
    const { cid } = candParams.parse(req.params);
    const b = candidatePatchBody.parse({
      ...(req.body?.name !== undefined ? { name: req.body.name } : {}),
      ...(req.body?.bio !== undefined ? { bio: req.body.bio } : {}),
      ...(req.body?.removePhoto !== undefined ? { removePhoto: req.body.removePhoto } : {}),
    });
    const newPhoto = req.file ? await savePhoto(req.file.buffer) : null;
    try {
      const { cand, oldPhoto } = await inDraftTx(c.id, async (tx) => {
        const old = await tx.query('SELECT photo_path FROM candidates WHERE id = $1 AND campaign_id = $2 FOR UPDATE', [cid, c.id]);
        if (!old.rowCount) throw notFound();
        const setPhoto = newPhoto !== null || b.removePhoto === 'true';
        const { rows } = await tx.query(
          `UPDATE candidates SET name = COALESCE($3, name),
             bio = CASE WHEN $4::boolean THEN NULLIF($5, '') ELSE bio END,
             photo_path = CASE WHEN $6::boolean THEN $7 ELSE photo_path END
           WHERE id = $1 AND campaign_id = $2 RETURNING id, name, bio, photo_path, sort_order`,
          [cid, c.id, b.name ?? null, b.bio !== undefined, b.bio ?? null, setPhoto, newPhoto]);
        await audit(tx, currentUser(req).oid, 'candidate.update', c.id, { candidate_id: cid });
        return { cand: rows[0], oldPhoto: setPhoto ? (old.rows[0].photo_path as string | null) : null };
      });
      await deletePhoto(oldPhoto);
      res.json({ ...cand, photo_url: photoUrl(cand), photo_path: undefined });
    } catch (e) { await deletePhoto(newPhoto); throw e; }
  });

  r.delete('/:id/candidates/:cid', loadOwned, async (req, res) => {
    const c = camp(res);
    const { cid } = candParams.parse(req.params);
    const photo = await inDraftTx(c.id, async (tx) => {
      const { rows } = await tx.query('DELETE FROM candidates WHERE id = $1 AND campaign_id = $2 RETURNING photo_path', [cid, c.id]);
      if (!rows.length) throw notFound();
      await audit(tx, currentUser(req).oid, 'candidate.delete', c.id, { candidate_id: cid });
      return rows[0].photo_path as string | null;
    });
    await deletePhoto(photo);
    res.status(204).end();
  });

  r.put('/:id/eligible', loadOwned, async (req, res) => {
    const c = camp(res);
    const b = eligibleBody.parse(req.body);
    let emails: string[] = [];
    if (b.mode === 'list') {
      const norm = b.emails.map(normalizeEmail);
      const bad = norm.filter((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
      if (bad.length) throw new HttpError(400, `Invalid email address(es): ${bad.slice(0, 5).join(', ')}`);
      emails = [...new Set(norm)];
    }
    await inDraftTx(c.id, async (tx) => {
      await tx.query('UPDATE campaigns SET eligibility = $2 WHERE id = $1', [c.id, b.mode]);
      await tx.query('DELETE FROM eligible_voters WHERE campaign_id = $1', [c.id]);
      if (emails.length) await tx.query('INSERT INTO eligible_voters (campaign_id, voter_email) SELECT $1, unnest($2::text[])', [c.id, emails]);
      await audit(tx, currentUser(req).oid, 'eligibility.set', c.id, { mode: b.mode, count: emails.length });
    });
    res.json({ mode: b.mode, count: emails.length });
  });

  r.post('/:id/start', loadOwned, async (req, res) => {
    const c = camp(res);
    await inDraftTx(c.id, async (tx) => {
      const n = (await tx.query('SELECT count(*)::int AS n FROM candidates WHERE campaign_id = $1', [c.id])).rows[0].n;
      if (n < 2) throw new HttpError(409, 'At least 2 candidates are required to start', 'needs_candidates');
      const fresh = (await tx.query('SELECT eligibility, closes_at FROM campaigns WHERE id = $1', [c.id])).rows[0];
      if (fresh.eligibility === 'list') {
        const e = (await tx.query('SELECT count(*)::int AS n FROM eligible_voters WHERE campaign_id = $1', [c.id])).rows[0].n;
        if (e < 1) throw new HttpError(409, 'The eligible voter list is empty', 'needs_voters');
      }
      if (fresh.closes_at && fresh.closes_at <= new Date()) throw new HttpError(409, 'closes_at is in the past', 'bad_window');
      await tx.query("UPDATE campaigns SET status = 'open' WHERE id = $1", [c.id]);
      await audit(tx, currentUser(req).oid, 'campaign.start', c.id, { candidates: n });
    });
    res.json({ status: 'open' });
  });

  r.post('/:id/close', loadOwned, async (req, res) => {
    const c = camp(res);
    const integrity = await withTx(async (tx) => {
      const { rows } = await tx.query('SELECT status FROM campaigns WHERE id = $1 FOR UPDATE', [c.id]);
      if (rows[0]?.status !== 'open') throw new HttpError(409, 'Only an open campaign can be closed', 'not_open');
      return closeInTx(tx, c.id, currentUser(req).oid, 'manual');
    });
    res.json({ status: 'closed', integrity });
  });

  r.get('/:id/results', loadOwned, async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: camp(res).status, results_published: camp(res).results_published, ...(await getResults(getPool(), camp(res).id)) });
  });

  r.post('/:id/publish', loadOwned, async (req, res) => {
    const c = camp(res);
    await withTx(async (tx) => {
      const { rows } = await tx.query('SELECT status FROM campaigns WHERE id = $1 FOR UPDATE', [c.id]);
      if (rows[0]?.status !== 'closed') throw new HttpError(409, 'Results can only be published after the campaign is closed', 'not_closed');
      await tx.query('UPDATE campaigns SET results_published = true WHERE id = $1', [c.id]);
      await audit(tx, currentUser(req).oid, 'results.publish', c.id);
    });
    res.json({ results_published: true });
  });

  r.get('/:id/qr.png', loadOwned, async (req, res) => {
    const png = await QRCode.toBuffer(shareUrl(camp(res).share_token), { type: 'png', width: 640, margin: 2, errorCorrectionLevel: 'M' });
    if (req.query.download === '1') await audit(getPool(), currentUser(req).oid, 'qr.download', camp(res).id);   // previews are not audited
    res.type('png').set('Cache-Control', 'private, no-store').set('Content-Disposition', req.query.download === '1' ? 'attachment; filename="voting-qr.png"' : 'inline').send(png);
  });

  r.get('/:id/poster.pdf', loadOwned, async (req, res) => {
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

  r.get('/:id/results.csv', loadOwned, async (req, res) => {
    const c = camp(res);
    if (c.status !== 'closed') throw new HttpError(409, 'CSV export is only available after the campaign is closed', 'not_closed');
    const results = await getResults(getPool(), c.id);
    const lines = ['candidate,votes', ...results.candidates.map((x) => `${csvCell(x.name)},${x.votes}`), `Total ballots,${results.turnout.votes}`];
    await audit(getPool(), currentUser(req).oid, 'results.export_csv', c.id);
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="results.csv"').set('Cache-Control', 'private, no-store').send(lines.join('\r\n') + '\r\n');
  });

  return r;
}

export { ADMIN_ROLE };
