import { Router, type Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import { getConfig } from '../config.js';
import { getPool } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { currentUser, getCurrentUser, requireUser, type AuthUser } from '../auth/index.js';
import { clientIp } from '../auth/limits.js';
import { voterState } from '../domain/status.js';
import { tokenParams, uuid, voteBody } from '../domain/validation.js';
import { getNotices, getResetHistory, getResults, refreshStatus, type CampaignRow } from '../services/campaigns.js';
import { castVote, notMemberMessage } from '../services/voting.js';
import { isSnapshotMemberSql, liveMemberKey, logNotMember, umojaStanding } from '../services/umoja.js';

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
  return (await getPool().query('SELECT *, clock_timestamp() AS db_now FROM campaigns WHERE id = $1', [first.id])).rows[0];
}

async function standing(c: CampaignRow, u: AuthUser) {
  let notMember = false;
  let eligible: boolean;
  let memberKey = `oid:${u.oid}`;
  if (c.eligibility === 'umoja') {
    const s = await umojaStanding(getPool(), u.oid, c);
    notMember = s.reason !== 'member';
    if (s.reason !== 'member') logNotMember(s.reason, c.id, u.oid);   // the reason goes to the server log only
    else if (s.memberKey) memberKey = s.memberKey;
    eligible = !notMember;
  } else {
    eligible = c.eligibility === 'all' ||
      (await getPool().query('SELECT 1 FROM eligible_voters WHERE campaign_id = $1 AND voter_email = $2', [c.id, u.email.toLowerCase()])).rowCount! > 0;
  }
  // One vote per member and position (SEC-03): a second account of the same member sees "already voted" too. `votedPositions` are the
  // caller's own receipts (positions only: a receipt holds no candidate). "Already voted" for the campaign means every position is done.
  const votedPositions = new Set((await getPool().query('SELECT DISTINCT position_id FROM vote_receipts WHERE campaign_id = $1 AND (voter_oid = $2 OR member_key = $3)', [c.id, u.oid, memberKey])).rows.map((x) => x.position_id as string));
  const total = (await getPool().query('SELECT count(*)::int AS n FROM positions WHERE campaign_id = $1', [c.id])).rows[0].n as number;
  const hasVoted = total > 0 && votedPositions.size >= total;
  return { eligible, notMember, hasVoted, votedPositions, total, state: voterState(c, c.db_now ?? new Date(), { eligible, notMember, hasVoted }) };
}

interface BallotCandidate { id: string; name: string; bio: string | null; photo_path: string | null; is_abstain: boolean; withdrawn_at: Date | null; position_id: string; region_id: string | null; region: string | null }

/** Approved candidates only: a pending, rejected or withdrawn nomination is never on a ballot. */
async function ballotCandidates(campaignId: string, positionIds: string[]): Promise<BallotCandidate[]> {
  return (await getPool().query(
    `SELECT k.id, k.name, k.bio, k.photo_path, k.is_abstain, k.withdrawn_at, k.position_id, k.region_id, g.name AS region
       FROM candidates k JOIN positions p ON p.id = k.position_id LEFT JOIN regions g ON g.id = k.region_id
      WHERE k.campaign_id = $1 AND k.position_id = ANY($2::uuid[]) AND k.status = 'approved' ORDER BY p.sort_order, p.created_at, k.sort_order, k.name`, [campaignId, positionIds])).rows;
}
const candidateOut = (x: BallotCandidate) => ({
  id: x.id, name: x.name, bio: x.bio, photoUrl: x.photo_path ? `/api/photos/${x.id}` : null, isAbstain: x.is_abstain, withdrawn: x.withdrawn_at !== null,
  positionId: x.position_id, regionId: x.region_id, region: x.region,
});

export function voteRouter(): Router {
  const r = Router();
  r.use(requireUser);

  // GET routes (ballot page, My votes, results): each runs a lazy-close check and several queries, so they are throttled too.
  const readLimiter = rateLimit({
    windowMs: 60_000, limit: getConfig().readRateLimit, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: (req) => getCurrentUser(req as Request)?.oid ?? ipKeyGenerator(clientIp(req as Request)),
    message: { error: 'Too many requests' },
  });
  r.use((req, res, next) => (req.method === 'GET' ? readLimiter(req, res, next) : next()));

  const voteLimiter = rateLimit({
    windowMs: 60_000, limit: getConfig().voteRateLimit, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: (req) => getCurrentUser(req as Request)?.oid ?? ipKeyGenerator(req.ip ?? ''),
    message: { error: 'Too many requests' },
  });

  /** "My votes": open campaigns the caller may vote in (plus closed ones whose results are published). */
  r.get('/', async (req, res) => {
    const u = currentUser(req);
    const myKeys = [`oid:${u.oid}`, ...(await liveMemberKey(getPool(), u.oid).then((k) => (k ? [k] : [])))];
    const stale = await getPool().query("SELECT id FROM campaigns WHERE (status = 'open' AND closes_at IS NOT NULL AND closes_at <= now()) OR (status = 'closed' AND NOT results_published AND publish_at IS NOT NULL AND publish_at <= now())");
    for (const row of stale.rows) await refreshStatus(row.id);
    const { rows } = await getPool().query(
      `SELECT c.share_token, c.title, c.description, c.status, c.opens_at, c.closes_at, c.results_published, clock_timestamp() AS db_now,
              (SELECT count(DISTINCT v.position_id)::int FROM vote_receipts v WHERE v.campaign_id = c.id AND (v.voter_oid = $1 OR v.member_key = ANY($3::text[]))) AS positions_voted,
              (SELECT count(*)::int FROM positions p WHERE p.campaign_id = c.id) AS positions_total
         FROM campaigns c
        WHERE (c.status = 'open' OR (c.status = 'closed' AND c.results_published))
          AND (c.eligibility = 'all' OR (c.eligibility = 'umoja' AND ${isSnapshotMemberSql('c.id', '$1')})
               OR (c.eligibility = 'list' AND EXISTS (SELECT 1 FROM eligible_voters e WHERE e.campaign_id = c.id AND e.voter_email = $2)))
        ORDER BY c.closes_at NULLS LAST, c.created_at DESC`, [u.oid, u.email.toLowerCase(), myKeys]);
    res.set('Cache-Control', 'no-store').json({
      campaigns: rows.map((c) => ({
        shareToken: c.share_token, title: c.title, description: c.description, opensAt: c.opens_at, closesAt: c.closes_at,
        resultsPublished: c.results_published,
        voterState: voterState(c, c.db_now, { eligible: true, hasVoted: c.positions_total > 0 && c.positions_voted >= c.positions_total }),
        positions: { voted: c.positions_voted, total: c.positions_total },
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
    const posRows = (await getPool().query('SELECT id, title, description, seats FROM positions WHERE campaign_id = $1 ORDER BY sort_order, created_at', [c.id])).rows;
    // Candidates are loaded only for positions the caller has NOT voted in: a done position stays closed (its ballot is not served again).
    const open = posRows.filter((p) => !s.votedPositions.has(p.id));
    const cands = showCandidates && open.length ? await ballotCandidates(c.id, open.map((p) => p.id as string)) : [];
    const regions = showCandidates ? (await getPool().query('SELECT id, name FROM regions WHERE campaign_id = $1 ORDER BY sort_order, name', [c.id])).rows : [];
    res.set('Cache-Control', 'no-store').json({
      title: c.title, description: c.description, opensAt: c.opens_at, closesAt: c.closes_at,
      resultsPublished: c.results_published && c.status === 'closed',
      voterState: s.state,
      notices: await getNotices(getPool(), c.id, false),   // resets and early closes, with their reasons (SEC-01)
      candidates: cands.map(candidateOut),
      regions,
      progress: { voted: s.votedPositions.size, total: s.total },
      positions: showCandidates ? posRows.map((p) => ({
        id: p.id, title: p.title, description: p.description, seats: p.seats, voted: s.votedPositions.has(p.id),
        candidateCount: cands.filter((x) => x.position_id === p.id && !x.is_abstain && !x.withdrawn_at).length,
      })) : [],
    });
  });

  /** One position's ballot: its candidates (with region, photo and bio) and the regions to filter by. Refused (409) once the caller has voted in it. */
  r.get('/:shareToken/positions/:pid', async (req, res) => {
    const shareToken = parseToken(req);
    const pid = uuid.safeParse(req.params.pid);
    if (!pid.success) throw notFound();
    const u = currentUser(req);
    const c = await loadByToken(shareToken);
    const s = await standing(c, u);
    if (s.notMember) throw new HttpError(403, notMemberMessage, 'not_member');
    if (!s.eligible) throw new HttpError(403, 'You are not eligible to vote in this campaign', 'not_eligible');
    const pos = (await getPool().query('SELECT id, title, description, seats FROM positions WHERE id = $1 AND campaign_id = $2', [pid.data, c.id])).rows[0];
    if (!pos) throw notFound();
    if (c.status === 'closed') throw new HttpError(409, 'Voting has closed', 'closed');
    if (c.status === 'draft') throw new HttpError(409, 'Voting is not open yet', 'not_open');
    if (s.votedPositions.has(pos.id)) throw new HttpError(409, 'You have already voted in this position', 'already_voted');
    const cands = await ballotCandidates(c.id, [pos.id]);
    res.set('Cache-Control', 'no-store').json({
      position: { id: pos.id, title: pos.title, description: pos.description },
      campaign: { title: c.title, closesAt: c.closes_at },
      voterState: s.state,
      regions: (await getPool().query('SELECT id, name FROM regions WHERE campaign_id = $1 ORDER BY sort_order, name', [c.id])).rows,
      candidates: cands.map(candidateOut),
      progress: { voted: s.votedPositions.size, total: s.total },
    });
  });

  // NOTE: never log req.body here; it contains the ballot.
  r.post('/:shareToken', voteLimiter, async (req, res) => {
    const shareToken = parseToken(req);
    const { candidateId, positionId } = voteBody.parse(req.body);
    const u = currentUser(req);
    await castVote(u.oid, u.email, shareToken, candidateId, positionId);
    res.status(201).set('Cache-Control', 'no-store').json({ recorded: true });
  });

  /** Vote in one position. Each position is its own transaction and its own receipt; positions can be voted in any order. */
  r.post('/:shareToken/positions/:pid', voteLimiter, async (req, res) => {
    const shareToken = parseToken(req);
    const pid = uuid.safeParse(req.params.pid);
    if (!pid.success) throw notFound();
    const { candidateId } = z.object({ candidateId: uuid }).strict().parse(req.body);
    const u = currentUser(req);
    await castVote(u.oid, u.email, shareToken, candidateId, pid.data);
    res.status(201).set('Cache-Control', 'no-store').json({ recorded: true });
  });

  r.get('/:shareToken/results', async (req, res) => {
    const shareToken = parseToken(req);
    const c = await loadByToken(shareToken);
    const s = await standing(c, currentUser(req));
    if (s.notMember) throw new HttpError(403, notMemberMessage, 'not_member');
    if (!s.eligible) throw new HttpError(403, 'You are not eligible to view these results', 'not_eligible');
    if (c.status !== 'closed' || !c.results_published) throw new HttpError(404, 'Results are not published');
    res.set('Cache-Control', 'no-store').json({ title: c.title, ...(await getResults(getPool(), c.id)), resets: await getResetHistory(getPool(), c.id, false), notices: await getNotices(getPool(), c.id, false) });
  });

  return r;
}
