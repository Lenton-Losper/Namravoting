import { getConfig } from '../config.js';
import { getPool, type Queryable } from '../db.js';
import { getResults, type CampaignRow } from './campaigns.js';

/** The 14 regions of Namibia: the default list every new campaign starts with. An admin can rename, add or remove them per campaign. */
export const DEFAULT_REGIONS = [
  'Erongo', 'Hardap', '//Kharas', 'Kavango East', 'Kavango West', 'Khomas', 'Kunene',
  'Ohangwena', 'Omaheke', 'Omusati', 'Oshana', 'Oshikoto', 'Otjozondjupa', 'Zambezi',
] as const;

export async function seedRegions(db: Queryable, campaignId: string): Promise<void> {
  await db.query('INSERT INTO regions (campaign_id, name, sort_order) SELECT $1, n, o FROM unnest($2::text[]) WITH ORDINALITY AS t(n, o)', [campaignId, [...DEFAULT_REGIONS]]);
}

export interface PositionRow {
  id: string; campaign_id: string; title: string; description: string | null; sort_order: number; seats: number;
  min_candidates: number | null; max_candidates: number | null; status: 'open' | 'closed'; rules: Record<string, unknown>; invite_token: string | null;
}

/** The campaign's only position, created on first use. Keeps the single-question API (add a candidate with no position) working. */
export async function defaultPosition(db: Queryable, campaignId: string, title: string): Promise<string> {
  const rows = (await db.query('SELECT id FROM positions WHERE campaign_id = $1 ORDER BY sort_order, created_at', [campaignId])).rows;
  if (rows.length === 1) return rows[0].id as string;
  if (rows.length > 1) return '';
  const ins = await db.query('INSERT INTO positions (campaign_id, title, sort_order) VALUES ($1, left($2, 200), 0) RETURNING id', [campaignId, title]);
  if ((await db.query('SELECT allow_abstain FROM campaigns WHERE id = $1', [campaignId])).rows[0]?.allow_abstain) await addAbstainLines(db, campaignId);
  return ins.rows[0].id as string;
}

/** Number of approved, non-abstain candidates a position needs before the campaign may start. */
export const requiredCandidates = (p: { min_candidates: number | null }): number => p.min_candidates ?? 2;

/** Positions that do not have enough approved candidates to start, with the reason. Empty = the campaign may start. */
export async function startProblems(db: Queryable, campaignId: string): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT p.title, p.min_candidates, p.max_candidates,
            (SELECT count(*)::int FROM candidates k WHERE k.position_id = p.id AND NOT k.is_abstain AND k.status = 'approved') AS approved
       FROM positions p WHERE p.campaign_id = $1 ORDER BY p.sort_order, p.created_at`, [campaignId]);
  if (!rows.length) return ['Add at least one position'];
  const out: string[] = [];
  for (const p of rows) {
    const need = requiredCandidates(p);
    if (p.approved < need) out.push(`${p.title}: needs at least ${need} approved candidates (has ${p.approved})`);
    else if (p.max_candidates != null && p.approved > p.max_candidates) out.push(`${p.title}: allows at most ${p.max_candidates} candidates (has ${p.approved})`);
  }
  return out;
}

export type NominationState = 'not_invited' | 'open' | 'closed' | 'expired' | 'ended';

/** Whether nominations for a position are accepted right now (database clock passed in as `now`). */
export function nominationState(c: { status: string; nominations_close_at?: Date | null }, p: { status: string; invite_token: string | null }, now: Date): NominationState {
  if (c.status !== 'draft') return 'ended';
  if (p.status === 'closed') return 'closed';
  if (c.nominations_close_at && c.nominations_close_at.getTime() <= now.getTime()) return 'expired';
  return p.invite_token ? 'open' : 'not_invited';
}

export interface PositionBlock {
  id: string; title: string; description: string | null; sort_order: number; seats: number;
  min_candidates: number | null; max_candidates: number | null; status: 'open' | 'closed';
  nomination_state: NominationState; invite_url: string | null;
  /** Candidates by status (the abstain line is not counted). */
  counts: { approved: number; submitted: number; rejected: number; withdrawn: number; invited: number };
  required: number;
  /** Closed campaigns only: members who voted here and the winner(s) / tie. Null while the campaign is not closed. */
  result: { turnout: number; winners: string[]; tie: string[] | null } | null;
}

/** The position blocks of a campaign for the admin screen. Per-position results are included only once the campaign is closed (SEC-01). */
export async function positionBlocks(c: CampaignRow): Promise<PositionBlock[]> {
  const db = getPool();
  const now = (await db.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  const { rows } = await db.query(
    `SELECT p.*,
            count(k.id) FILTER (WHERE k.status = 'approved' AND NOT k.is_abstain)::int AS approved,
            count(k.id) FILTER (WHERE k.status = 'submitted')::int AS submitted,
            count(k.id) FILTER (WHERE k.status = 'rejected')::int AS rejected,
            count(k.id) FILTER (WHERE k.status = 'withdrawn')::int AS withdrawn,
            count(k.id) FILTER (WHERE k.status = 'invited')::int AS invited
       FROM positions p LEFT JOIN candidates k ON k.position_id = p.id
      WHERE p.campaign_id = $1 GROUP BY p.id ORDER BY p.sort_order, p.created_at`, [c.id]);
  const results = c.status === 'closed' ? await getResults(db, c.id) : null;
  return rows.map((p) => {
    const res = results?.positions.find((x) => x.id === p.id);
    return {
      id: p.id, title: p.title, description: p.description, sort_order: p.sort_order, seats: p.seats,
      min_candidates: p.min_candidates, max_candidates: p.max_candidates, status: p.status,
      nomination_state: nominationState(c, p, now),
      invite_url: p.invite_token ? `${getConfig().publicBaseUrl}/n/${p.invite_token}` : null,
      counts: { approved: p.approved, submitted: p.submitted, rejected: p.rejected, withdrawn: p.withdrawn, invited: p.invited },
      required: requiredCandidates(p),
      result: res ? { turnout: res.turnout.votes, winners: res.winners.map((w) => w.name), tie: res.tie ? res.tie.names : null } : null,
    };
  });
}

/** The ballot's Abstain line: a candidate row flagged is_abstain (sorted last), so it gets a tally counter like everyone else. */
export const ABSTAIN_NAME = 'Abstain (none of the above)';
export async function setAbstain(tx: Queryable, id: string, on: boolean): Promise<void> {
  await tx.query('UPDATE campaigns SET allow_abstain = $2 WHERE id = $1', [id, on]);
  if (on) await addAbstainLines(tx, id);
  else await tx.query('DELETE FROM candidates WHERE campaign_id = $1 AND is_abstain', [id]);
}
/** One Abstain line per position that does not have one yet (also called when a position is added to a campaign that allows abstaining). */
export async function addAbstainLines(tx: Queryable, id: string): Promise<void> {
  await tx.query(
    "INSERT INTO candidates (campaign_id, position_id, name, sort_order, is_abstain) SELECT $1, p.id, $2, 2000000000, true FROM positions p WHERE p.campaign_id = $1 ON CONFLICT DO NOTHING",
    [id, ABSTAIN_NAME]);
}

