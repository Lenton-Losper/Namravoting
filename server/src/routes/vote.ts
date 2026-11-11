import { Router, type Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { getConfig } from '../config.js';
import { getPool } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { currentUser, getCurrentUser, requireUser, type AuthUser } from '../auth/index.js';
import { voterState } from '../domain/status.js';
import { tokenParams, voteBody } from '../domain/validation.js';
import { getResetHistory, getResults, refreshStatus, type CampaignRow } from '../services/campaigns.js';
import { castVote, notMemberMessage } from '../services/voting.js';
import { isActiveMemberSql, logNotMember, umojaReason } from '../services/umoja.js';

/** Malformed and unknown tokens answer identically (404) so nothing reveals whether a campaign exists. */
function parseToken(req: Request): string {
  const p = tokenParams.safeParse(req.params);
  if (!p.success) throw notFound();
  return p.data.shareToken;
}

async function loadByToken(token: string): Promise<CampaignRow> {
  const first = (await getPool().query('SELECT id FROM campaigns WHERE share_token = $1', [token])).rows[0];
  if (!first) throw notFound();
  await refreshStatus(first.id);           // lazy auto-close
  return (await getPool().query('SELECT * FROM campaigns WHERE id = $1', [first.id])).rows[0];
}

async function standing(c: CampaignRow, u: AuthUser) {
  let notMember = false;
  let eligible: boolean;
  if (c.eligibility === 'umoja') {
    const reason = await umojaReason(getPool(), u.oid);
    notMember = reason !== 'member';
    if (reason !== 'member') logNotMember(reason, c.id, u.oid);   // the reason goes to the server log only
    eligible = !notMember;
  } else {
    eligible = c.eligibility === 'all' ||
      (await getPool().query('SELECT 1 FROM eligible_voters WHERE campaign_id = $1 AND voter_email = $2', [c.id, u.email.toLowerCase()])).rowCount! > 0;
  }
  const hasVoted = (await getPool().query('SELECT 1 FROM vote_receipts WHERE campaign_id = $1 AND voter_oid = $2', [c.id, u.oid])).rowCount! > 0;
  return { eligible, notMember, hasVoted, state: voterState(c, new Date(), { eligible, notMember, hasVoted }) };
}

export function voteRouter(): Router {
  const r = Router();
  r.use(requireUser);

  const voteLimiter = rateLimit({
    windowMs: 60_000, limit: getConfig().voteRateLimit, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: (req) => getCurrentUser(req as Request)?.oid ?? ipKeyGenerator(req.ip ?? ''),
    message: { error: 'Too many requests' },
  });

  /** "My votes": open campaigns the caller may vote in (plus closed ones whose results are published). */
  r.get('/', async (req, res) => {
    const u = currentUser(req);
    const stale = await getPool().query("SELECT id FROM campaigns WHERE status = 'open' AND closes_at IS NOT NULL AND closes_at <= now()");
    for (const row of stale.rows) await refreshStatus(row.id);
    const { rows } = await getPool().query(
      `SELECT c.share_token, c.title, c.description, c.status, c.opens_at, c.closes_at, c.results_published,
              EXISTS (SELECT 1 FROM vote_receipts v WHERE v.campaign_id = c.id AND v.voter_oid = $1) AS has_voted
         FROM campaigns c
        WHERE (c.status = 'open' OR (c.status = 'closed' AND c.results_published))
          AND (c.eligibility = 'all' OR (c.eligibility = 'umoja' AND ${isActiveMemberSql('$1')})
               OR (c.eligibility = 'list' AND EXISTS (SELECT 1 FROM eligible_voters e WHERE e.campaign_id = c.id AND e.voter_email = $2)))
        ORDER BY c.closes_at NULLS LAST, c.created_at DESC`, [u.oid, u.email.toLowerCase()]);
    const now = new Date();
    res.set('Cache-Control', 'no-store').json({
      campaigns: rows.map((c) => ({
        shareToken: c.share_token, title: c.title, description: c.description, opensAt: c.opens_at, closesAt: c.closes_at,
        resultsPublished: c.results_published,
        voterState: voterState(c, now, { eligible: true, hasVoted: c.has_voted }),
      })),
    });
  });

  r.get('/:shareToken', async (req, res) => {
    const shareToken = parseToken(req);
    const u = currentUser(req);
    const c = await loadByToken(shareToken);
    const s = await standing(c, u);
    // Ineligible callers get no campaign data at all (not even the title).
    if (s.notMember) throw new HttpError(403, notMemberMessage, 'not_member');
    if (!s.eligible) throw new HttpError(403, 'You are not eligible to vote in this campaign', 'not_eligible');
    const showCandidates = c.status !== 'draft';
    const cands = showCandidates
      ? (await getPool().query('SELECT id, name, bio, photo_path FROM candidates WHERE campaign_id = $1 ORDER BY sort_order, name', [c.id])).rows
      : [];
    res.set('Cache-Control', 'no-store').json({
      title: c.title, description: c.description, opensAt: c.opens_at, closesAt: c.closes_at,
      resultsPublished: c.results_published && c.status === 'closed',
      voterState: s.state,
      candidates: cands.map((x) => ({ id: x.id, name: x.name, bio: x.bio, photoUrl: x.photo_path ? `/api/photos/${x.id}` : null })),
    });
  });

  // NOTE: never log req.body here; it contains the ballot.
  r.post('/:shareToken', voteLimiter, async (req, res) => {
    const shareToken = parseToken(req);
    const { candidateId } = voteBody.parse(req.body);
    const u = currentUser(req);
    await castVote(u.oid, u.email, shareToken, candidateId);
    res.status(201).set('Cache-Control', 'no-store').json({ recorded: true });
  });

  r.get('/:shareToken/results', async (req, res) => {
    const shareToken = parseToken(req);
    const c = await loadByToken(shareToken);
    const s = await standing(c, currentUser(req));
    if (s.notMember) throw new HttpError(403, notMemberMessage, 'not_member');
    if (!s.eligible) throw new HttpError(403, 'You are not eligible to view these results', 'not_eligible');
    if (c.status !== 'closed' || !c.results_published) throw new HttpError(404, 'Results are not published');
    res.set('Cache-Control', 'no-store').json({ title: c.title, ...(await getResults(getPool(), c.id)), resets: await getResetHistory(getPool(), c.id, false) });
  });

  return r;
}
