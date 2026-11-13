import crypto from 'node:crypto';
import { Router, type RequestHandler, type Response } from 'express';
import type { PoolClient } from 'pg';
import QRCode from 'qrcode';
import { z } from 'zod';
import { getConfig } from '../config.js';
import { getPool } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { currentUser } from '../auth/index.js';
import { candParams, positionBody, positionParams, positionPatchBody, regionBody, regionParams, rejectBody, reorderBody } from '../domain/validation.js';
import { audit } from '../services/audit.js';
import type { CampaignRow } from '../services/campaigns.js';
import { deletePhoto } from '../services/images.js';
import { addAbstainLines, positionBlocks } from '../services/positions.js';

/**
 * Admin side of positions, regions and nominations. Every route sits behind loadRunnable (the creator or a co-admin of THIS campaign):
 * anyone else, and any id that does not exist, gets the same 404 and an audit entry.
 *
 *   positions      add, edit, reorder and remove while the campaign is a draft (title and description may also change while it is OPEN
 *                  with "Allow edits after start", like the campaign's own title; everything else is locked from the start)
 *   invite links   one nomination link (and QR code) per position; closes when the campaign starts or at the optional deadline
 *   nominations    the admin approves or rejects each submitted profile (with a reason); only approved candidates reach the ballot
 *   regions        the per-campaign list candidates choose from (default: the 14 regions of Namibia)
 */
interface Deps {
  loadRunnable: RequestHandler;
  camp: (res: Response) => CampaignRow;
  inDraftTx: <T>(id: string, fn: (c: PoolClient) => Promise<T>) => Promise<T>;
  inEditTx: <T>(id: string, fn: (c: PoolClient, live: boolean) => Promise<T>) => Promise<T>;
}

const trunc = (v: string | null | undefined) => (v == null ? null : v.length > 300 ? v.slice(0, 300) + '…' : v);

export function positionsRouter(d: Deps): Router {
  const r = Router({ mergeParams: true });
  const { loadRunnable, camp } = d;

  /** A position of THIS campaign, locked FOR UPDATE; 404 otherwise. */
  const lockPosition = async (tx: PoolClient, campaignId: string, pid: string) => {
    const row = (await tx.query('SELECT * FROM positions WHERE id = $1 AND campaign_id = $2 FOR UPDATE', [pid, campaignId])).rows[0];
    if (!row) throw notFound();
    return row;
  };

  // ---- positions ------------------------------------------------------------------------------------------------------------------

  r.get('/positions', loadRunnable, async (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ positions: await positionBlocks(camp(res)) });
  });

  r.post('/positions', loadRunnable, async (req, res) => {
    const c = camp(res); const u = currentUser(req);
    const b = positionBody.parse(req.body);
    const created = await d.inDraftTx(c.id, async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO positions (campaign_id, title, description, seats, min_candidates, max_candidates, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,(SELECT COALESCE(max(sort_order), 0) + 1 FROM positions WHERE campaign_id = $1)) RETURNING id, title`,
        [c.id, b.title, b.description ?? null, b.seats ?? 1, b.min_candidates ?? null, b.max_candidates ?? null]);
      if (c.allow_abstain) await addAbstainLines(tx, c.id);   // a campaign that allows abstaining gets the line on every position
      await audit(tx, u.oid, 'position.add', c.id, { position_id: rows[0].id, title: rows[0].title });
      return rows[0];
    });
    res.status(201).json({ id: created.id, positions: await positionBlocks(camp(res)) });
  });

  /** Order of the blocks. Must list every position of the campaign exactly once. */
  r.post('/positions/reorder', loadRunnable, async (req, res) => {
    const c = camp(res); const u = currentUser(req);
    const b = reorderBody.parse(req.body);
    await d.inDraftTx(c.id, async (tx) => {
      const have = (await tx.query('SELECT id FROM positions WHERE campaign_id = $1 FOR UPDATE', [c.id])).rows.map((x) => x.id as string);
      if (new Set(b.ids).size !== b.ids.length || b.ids.length !== have.length || !b.ids.every((i) => have.includes(i))) {
        throw new HttpError(400, 'List every position of this campaign exactly once', 'bad_order');
      }
      for (const [i, id] of b.ids.entries()) await tx.query('UPDATE positions SET sort_order = $3 WHERE id = $1 AND campaign_id = $2', [id, c.id, i + 1]);
      await audit(tx, u.oid, 'position.reorder', c.id, { count: b.ids.length });
    });
    res.json({ positions: await positionBlocks(camp(res)) });
  });

  r.patch('/positions/:pid', loadRunnable, async (req, res) => {
    const c = camp(res); const u = currentUser(req);
    const { pid } = positionParams.parse(req.params);
    const b = positionPatchBody.parse(req.body);
    await d.inEditTx(c.id, async (tx, live) => {
      const cur = await lockPosition(tx, c.id, pid);
      if (live) {
        // Open campaign with "Allow edits after start": title and description only (the database enforces the same).
        if (b.seats !== undefined || b.min_candidates !== undefined || b.max_candidates !== undefined || b.status !== undefined) {
          throw new HttpError(409, 'Once voting has started only a position\'s title and description can change', 'locked');
        }
        const changes: { what: string; name?: string; from?: string | null; to?: string | null }[] = [];
        if (b.title !== undefined && b.title !== cur.title) changes.push({ what: 'position_title', name: cur.title, from: cur.title, to: b.title });
        if (b.description !== undefined && (b.description ?? null) !== (cur.description ?? null)) changes.push({ what: 'position_description', name: cur.title, from: trunc(cur.description), to: trunc(b.description) });
        if (!changes.length) return;
        await tx.query('UPDATE positions SET title = coalesce($3, title), description = CASE WHEN $4::boolean THEN $5 ELSE description END WHERE id = $1 AND campaign_id = $2',
          [pid, c.id, b.title ?? null, b.description !== undefined, b.description ?? null]);
        await audit(tx, u.oid, 'campaign.edit_after_start', c.id, { changes });
        return;
      }
      const min = b.min_candidates !== undefined ? b.min_candidates : cur.min_candidates;
      const max = b.max_candidates !== undefined ? b.max_candidates : cur.max_candidates;
      if (min != null && max != null && max < min) throw new HttpError(400, 'The maximum cannot be below the minimum', 'bad_limits');
      await tx.query(
        `UPDATE positions SET title = coalesce($3, title),
           description = CASE WHEN $4::boolean THEN $5 ELSE description END,
           seats = coalesce($6, seats),
           min_candidates = CASE WHEN $7::boolean THEN $8::int ELSE min_candidates END,
           max_candidates = CASE WHEN $9::boolean THEN $10::int ELSE max_candidates END,
           status = coalesce($11, status)
         WHERE id = $1 AND campaign_id = $2`,
        [pid, c.id, b.title ?? null, b.description !== undefined, b.description ?? null, b.seats ?? null,
         b.min_candidates !== undefined, b.min_candidates ?? null, b.max_candidates !== undefined, b.max_candidates ?? null, b.status ?? null]);
      await audit(tx, u.oid, 'position.update', c.id, { position_id: pid, fields: Object.keys(b) });
    });
    res.json({ positions: await positionBlocks(camp(res)) });
  });

  r.delete('/positions/:pid', loadRunnable, async (req, res) => {
    const c = camp(res); const u = currentUser(req);
    const { pid } = positionParams.parse(req.params);
    const photos = await d.inDraftTx(c.id, async (tx) => {
      const cur = await lockPosition(tx, c.id, pid);
      const ph = (await tx.query('SELECT photo_path FROM candidates WHERE position_id = $1 AND photo_path IS NOT NULL', [pid])).rows.map((x) => x.photo_path as string);
      const n = (await tx.query('SELECT count(*)::int AS n FROM candidates WHERE position_id = $1 AND NOT is_abstain', [pid])).rows[0].n as number;
      await tx.query('DELETE FROM candidates WHERE position_id = $1', [pid]);
      await tx.query('DELETE FROM positions WHERE id = $1 AND campaign_id = $2', [pid, c.id]);
      await audit(tx, u.oid, 'position.remove', c.id, { position_id: pid, title: cur.title, candidates_removed: n });
      return ph;
    });
    for (const p of photos) { try { await deletePhoto(p); } catch { /* the row is gone; a stray file is harmless */ } }
    res.status(204).end();
  });

  // ---- nomination links -------------------------------------------------------------------------------------------------------------

  /** Creates the position's nomination link (or returns the existing one). The link only works while the campaign is a draft. */
  r.post('/positions/:pid/invite', loadRunnable, async (req, res) => {
    const c = camp(res); const u = currentUser(req);
    const { pid } = positionParams.parse(req.params);
    await d.inDraftTx(c.id, async (tx) => {
      const cur = await lockPosition(tx, c.id, pid);
      if (cur.invite_token) return;
      await tx.query('UPDATE positions SET invite_token = $3 WHERE id = $1 AND campaign_id = $2', [pid, c.id, crypto.randomBytes(24).toString('base64url')]);
      await audit(tx, u.oid, 'nomination.invite', c.id, { position_id: pid, title: cur.title });
    });
    const block = (await positionBlocks(camp(res))).find((x) => x.id === pid);
    res.status(201).json({ invite_url: block?.invite_url ?? null, position: block });
  });

  /** Switches the link off. A new one can be created afterwards (the old link stops working for good). */
  r.delete('/positions/:pid/invite', loadRunnable, async (req, res) => {
    const c = camp(res); const u = currentUser(req);
    const { pid } = positionParams.parse(req.params);
    await d.inDraftTx(c.id, async (tx) => {
      const cur = await lockPosition(tx, c.id, pid);
      if (!cur.invite_token) return;
      await tx.query('UPDATE positions SET invite_token = NULL WHERE id = $1 AND campaign_id = $2', [pid, c.id]);
      await audit(tx, u.oid, 'nomination.invite_revoked', c.id, { position_id: pid, title: cur.title });
    });
    res.status(204).end();
  });

  r.get('/positions/:pid/invite.png', loadRunnable, async (req, res) => {
    const c = camp(res);
    const { pid } = positionParams.parse(req.params);
    const row = (await getPool().query('SELECT invite_token FROM positions WHERE id = $1 AND campaign_id = $2', [pid, c.id])).rows[0];
    if (!row) throw notFound();
    if (!row.invite_token) throw new HttpError(409, 'Create the nomination link first', 'no_invite');
    const png = await QRCode.toBuffer(`${getConfig().publicBaseUrl}/n/${row.invite_token}`, { type: 'png', width: 640, margin: 2, errorCorrectionLevel: 'M' });
    if (req.query.download === '1') await audit(getPool(), currentUser(req).oid, 'nomination.qr_download', c.id, { position_id: pid });
    res.type('png').set('Cache-Control', 'private, no-store').set('Content-Disposition', req.query.download === '1' ? 'attachment; filename="nomination-qr.png"' : 'inline').send(png);
  });

  // ---- reviewing nominations --------------------------------------------------------------------------------------------------------

  /** Every profile for a position, with who submitted it. The admin reads this to approve or reject. */
  r.get('/positions/:pid/nominations', loadRunnable, async (req, res) => {
    const c = camp(res);
    const { pid } = positionParams.parse(req.params);
    if (!(await getPool().query('SELECT 1 FROM positions WHERE id = $1 AND campaign_id = $2', [pid, c.id])).rowCount) throw notFound();
    const { rows } = await getPool().query(
      `SELECT k.id, k.name, k.bio, k.photo_path, k.status, k.region_id, g.name AS region, k.submitted_at, k.review_reason, k.reviewed_at,
              s.display_name AS submitted_by, s.email AS submitted_by_email, v.display_name AS reviewed_by
         FROM candidates k LEFT JOIN regions g ON g.id = k.region_id LEFT JOIN users s ON s.entra_oid = k.submitted_by_oid LEFT JOIN users v ON v.entra_oid = k.reviewed_by
        WHERE k.position_id = $1 AND NOT k.is_abstain ORDER BY k.submitted_at NULLS FIRST, k.sort_order, k.name`, [pid]);
    res.set('Cache-Control', 'no-store').json({
      nominations: rows.map((x) => ({
        id: x.id, name: x.name, bio: x.bio, photo_url: x.photo_path && !c.photos_purged_at ? `/api/photos/${x.id}` : null, status: x.status, region_id: x.region_id, region: x.region,
        submitted_at: x.submitted_at, submitted_by: x.submitted_by, submitted_by_email: x.submitted_by_email, review_reason: x.review_reason, reviewed_at: x.reviewed_at, reviewed_by: x.reviewed_by,
      })),
    });
  });

  r.post('/candidates/:cid/approve', loadRunnable, async (req, res) => {
    const c = camp(res); const u = currentUser(req);
    const { cid } = candParams.parse(req.params);
    await d.inDraftTx(c.id, async (tx) => {
      const k = (await tx.query('SELECT k.name, k.status, k.position_id, k.is_abstain, p.max_candidates FROM candidates k JOIN positions p ON p.id = k.position_id WHERE k.id = $1 AND k.campaign_id = $2 FOR UPDATE OF k', [cid, c.id])).rows[0];
      if (!k || k.is_abstain) throw notFound();
      if (k.status === 'approved') throw new HttpError(409, 'This profile is already approved', 'already_approved');
      if (k.status !== 'submitted' && k.status !== 'rejected') throw new HttpError(409, 'Only a submitted profile can be approved', 'not_submitted');
      if (k.max_candidates != null && (await tx.query("SELECT count(*)::int AS n FROM candidates WHERE position_id = $1 AND NOT is_abstain AND status = 'approved'", [k.position_id])).rows[0].n >= k.max_candidates) {
        throw new HttpError(409, `This position allows at most ${k.max_candidates} candidates`, 'position_full');
      }
      await tx.query("UPDATE candidates SET status = 'approved', reviewed_by = $2, reviewed_at = now(), review_reason = NULL WHERE id = $1", [cid, u.oid]);
      await audit(tx, u.oid, 'nomination.approve', c.id, { candidate_id: cid, position_id: k.position_id, name: k.name });
    });
    res.json({ status: 'approved' });
  });

  r.post('/candidates/:cid/reject', loadRunnable, async (req, res) => {
    const c = camp(res); const u = currentUser(req);
    const { cid } = candParams.parse(req.params);
    const b = rejectBody.parse(req.body);
    await d.inDraftTx(c.id, async (tx) => {
      const k = (await tx.query('SELECT name, status, position_id, is_abstain FROM candidates WHERE id = $1 AND campaign_id = $2 FOR UPDATE', [cid, c.id])).rows[0];
      if (!k || k.is_abstain) throw notFound();
      if (k.status !== 'submitted' && k.status !== 'approved') throw new HttpError(409, 'Only a submitted or approved profile can be rejected', 'not_reviewable');
      await tx.query("UPDATE candidates SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_reason = $3 WHERE id = $1", [cid, u.oid, b.reason]);
      await audit(tx, u.oid, 'nomination.reject', c.id, { candidate_id: cid, position_id: k.position_id, name: k.name, reason: b.reason });
    });
    res.json({ status: 'rejected' });
  });

  // ---- regions ----------------------------------------------------------------------------------------------------------------------

  r.get('/regions', loadRunnable, async (_req, res) => {
    const c = camp(res);
    const { rows } = await getPool().query(
      `SELECT g.id, g.name, g.sort_order, (SELECT count(*)::int FROM candidates k WHERE k.region_id = g.id) AS candidates
         FROM regions g WHERE g.campaign_id = $1 ORDER BY g.sort_order, g.name`, [c.id]);
    res.set('Cache-Control', 'no-store').json({ regions: rows });
  });

  r.post('/regions', loadRunnable, async (req, res) => {
    const c = camp(res); const u = currentUser(req);
    const b = regionBody.parse(req.body);
    const row = await d.inDraftTx(c.id, async (tx) => {
      if ((await tx.query('SELECT 1 FROM regions WHERE campaign_id = $1 AND lower(name) = lower($2)', [c.id, b.name])).rowCount) throw new HttpError(409, 'That region already exists', 'duplicate_region');
      const { rows } = await tx.query('INSERT INTO regions (campaign_id, name, sort_order) VALUES ($1, $2, (SELECT COALESCE(max(sort_order), 0) + 1 FROM regions WHERE campaign_id = $1)) RETURNING id, name, sort_order', [c.id, b.name]);
      await audit(tx, u.oid, 'region.add', c.id, { region_id: rows[0].id, name: b.name });
      return rows[0];
    });
    res.status(201).json(row);
  });

  r.patch('/regions/:rid', loadRunnable, async (req, res) => {
    const c = camp(res); const u = currentUser(req);
    const { rid } = regionParams.parse(req.params);
    const b = regionBody.parse(req.body);
    const row = await d.inDraftTx(c.id, async (tx) => {
      const old = (await tx.query('SELECT name FROM regions WHERE id = $1 AND campaign_id = $2 FOR UPDATE', [rid, c.id])).rows[0];
      if (!old) throw notFound();
      if ((await tx.query('SELECT 1 FROM regions WHERE campaign_id = $1 AND lower(name) = lower($2) AND id <> $3', [c.id, b.name, rid])).rowCount) throw new HttpError(409, 'That region already exists', 'duplicate_region');
      const { rows } = await tx.query('UPDATE regions SET name = $3 WHERE id = $1 AND campaign_id = $2 RETURNING id, name, sort_order', [rid, c.id, b.name]);
      await audit(tx, u.oid, 'region.rename', c.id, { region_id: rid, from: old.name, to: b.name });
      return rows[0];
    });
    res.json(row);
  });

  r.delete('/regions/:rid', loadRunnable, async (req, res) => {
    const c = camp(res); const u = currentUser(req);
    const { rid } = regionParams.parse(req.params);
    await d.inDraftTx(c.id, async (tx) => {
      const old = (await tx.query('SELECT name FROM regions WHERE id = $1 AND campaign_id = $2 FOR UPDATE', [rid, c.id])).rows[0];
      if (!old) throw notFound();
      const used = (await tx.query('SELECT count(*)::int AS n FROM candidates WHERE region_id = $1', [rid])).rows[0].n as number;
      if (used) throw new HttpError(409, `${used} candidate${used === 1 ? ' is' : 's are'} in ${old.name}. Move them to another region first.`, 'region_in_use');
      await tx.query('DELETE FROM regions WHERE id = $1 AND campaign_id = $2', [rid, c.id]);
      await audit(tx, u.oid, 'region.remove', c.id, { region_id: rid, name: old.name });
    });
    res.status(204).end();
  });

  // ---- results view -----------------------------------------------------------------------------------------------------------------

  /** Show the results grouped by region (a display choice, so it can change at any time, including after the campaign closed). */
  r.put('/results-view', loadRunnable, async (req, res) => {
    const c = camp(res); const u = currentUser(req);
    const b = z.object({ group_by_region: z.boolean() }).strict().parse(req.body);
    await getPool().query('UPDATE campaigns SET results_group_by_region = $2 WHERE id = $1', [c.id, b.group_by_region]);
    await audit(getPool(), u.oid, 'results.view_changed', c.id, { group_by_region: b.group_by_region });
    res.json({ group_by_region: b.group_by_region });
  });

  return r;
}
