import { isSnapshotMemberSql } from '../services/umoja.js';
import { Router } from 'express';
import { z } from 'zod';
import { getPool } from '../db.js';
import { notFound } from '../errors.js';
import { currentUser, requireUser } from '../auth/index.js';
import { readPhoto } from '../services/images.js';

/** Authenticated photo route. Files live outside any static folder under random names. */
export function photosRouter(): Router {
  const r = Router();
  r.use(requireUser);
  r.get('/:cid', async (req, res) => {
    const { cid } = z.object({ cid: z.string().uuid() }).parse(req.params);
    const me = currentUser(req);
    const { rows } = await getPool().query(
      `SELECT c.photo_path, k.status, k.created_by,
              EXISTS (SELECT 1 FROM campaign_members m WHERE m.campaign_id = k.id AND m.user_oid = $4 AND m.role = 'co_admin') AS co_admin,
              (k.eligibility = 'all'
               OR (k.eligibility = 'umoja' AND ${isSnapshotMemberSql('k.id', '$3')})
               OR (k.eligibility = 'list' AND EXISTS (SELECT 1 FROM eligible_voters e WHERE e.campaign_id = k.id AND e.voter_email = $2))) AS eligible
         FROM candidates c JOIN campaigns k ON k.id = c.campaign_id WHERE c.id = $1`, [cid, me.email.toLowerCase(), me.oid, me.oid]);
    const row = rows[0];
    // Visible to the campaign's creator, or (once it has started) to voters who are eligible for it. Otherwise 404.
    const allowed = row && (row.created_by === me.oid || row.co_admin || (row.status !== 'draft' && row.eligible));
    if (!row?.photo_path || !allowed) throw notFound();
    const buf = await readPhoto(row.photo_path);
    if (!buf) throw notFound();
    res.type('image/jpeg').set('Cache-Control', 'private, max-age=300').send(buf);
  });
  return r;
}
