import { getConfig } from '../config.js';
import { getPool, type Queryable } from '../db.js';
import { HttpError } from '../errors.js';
import { chooseLabel, regionRuleText } from '../domain/rules.js';
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
  id: string; campaign_id: string; title: string; description: string | null; sort_order: number; seats: number; rule_text: string | null;
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

export interface RuleInput { min_outside: number; region_id: string }

/**
 * Settles and validates a position's voting rules on save. `minPicks` omitted = as many as `maxPicks` (an exact count); both omitted = the
 * number of winners. The region rule needs a region of THIS campaign and cannot ask for more outside picks than a voter may make.
 * (Whether enough candidates stand outside the region is a start check, because candidates are added after the rule is set.)
 */
export async function resolvePicks(db: Queryable, campaignId: string, i: { seats: number; minPicks?: number; maxPicks?: number; rule: RuleInput | null }): Promise<{ min: number; max: number; rule: RuleInput | null }> {
  const max = i.maxPicks ?? (i.minPicks !== undefined && i.minPicks > i.seats ? i.minPicks : i.seats);
  const min = i.minPicks ?? max;
  if (min > max) throw new HttpError(400, 'The minimum number of picks cannot be above the maximum', 'bad_picks');
  if (i.rule) {
    if (i.rule.min_outside > max) throw new HttpError(400, `The rule asks for ${i.rule.min_outside} picks from outside the region, but a voter can pick at most ${max}`, 'rule_exceeds_picks');
    if (!(await db.query('SELECT 1 FROM regions WHERE id = $1 AND campaign_id = $2', [i.rule.region_id, campaignId])).rowCount) throw new HttpError(400, 'That region does not belong to this campaign', 'invalid_region');
  }
  return { min, max, rule: i.rule };
}

/** The before/after of a rule change for the audit log, with the region NAME (ids mean nothing to a reader of the log). */
export async function ruleChange(db: Queryable, before: { min: number; max: number; rule: RuleInput | null } | null, after: { min: number; max: number; rule: RuleInput | null }) {
  const name = async (r: RuleInput | null) => r ? { min_outside: r.min_outside, region: (await db.query('SELECT name FROM regions WHERE id = $1', [r.region_id])).rows[0]?.name as string } : null;
  return { from: before ? { min_picks: before.min, max_picks: before.max, region_rule: await name(before.rule) } : null, to: { min_picks: after.min, max_picks: after.max, region_rule: await name(after.rule) } };
}

/** The voting rules of every position, as data, for the start seal. */
export async function positionRules(db: Queryable, campaignId: string) {
  const { rows } = await db.query(
    `SELECT p.id, p.title, p.seats, p.min_picks, p.max_picks, p.region_rule_min, g.name AS region
       FROM positions p LEFT JOIN regions g ON g.id = p.region_rule_region_id WHERE p.campaign_id = $1 ORDER BY p.sort_order, p.created_at`, [campaignId]);
  return rows.map((p) => ({ position_id: p.id as string, title: p.title as string, winners: p.seats as number, min_picks: p.min_picks as number, max_picks: p.max_picks as number,
    region_rule: p.region_rule_min == null ? null : { min_outside: p.region_rule_min as number, region: p.region as string, text: regionRuleText({ minOutside: p.region_rule_min, regionName: p.region }) } }));
}

/** Number of approved, non-abstain candidates a position needs before the campaign may start. */
export const requiredCandidates = (p: { min_candidates: number | null }): number => p.min_candidates ?? 2;

/** Positions that do not have enough approved candidates to start, with the reason. Empty = the campaign may start. */
export async function startProblems(db: Queryable, campaignId: string): Promise<string[]> {
  const { rows } = await db.query(
    `SELECT p.title, p.min_candidates, p.max_candidates, p.min_picks, p.max_picks, p.region_rule_min, g.name AS rule_region,
            (SELECT count(*)::int FROM candidates k WHERE k.position_id = p.id AND NOT k.is_abstain AND k.status = 'approved') AS approved,
            (SELECT count(*)::int FROM candidates k WHERE k.position_id = p.id AND NOT k.is_abstain AND k.status = 'approved' AND k.region_id IS DISTINCT FROM p.region_rule_region_id) AS outside,
            (SELECT string_agg(k.name, ', ' ORDER BY k.name) FROM candidates k WHERE k.position_id = p.id AND NOT k.is_abstain AND k.status = 'approved' AND k.region_id IS NULL) AS no_region
       FROM positions p LEFT JOIN regions g ON g.id = p.region_rule_region_id WHERE p.campaign_id = $1 ORDER BY p.sort_order, p.created_at`, [campaignId]);
  if (!rows.length) return ['Add at least one position'];
  const out: string[] = [];
  for (const p of rows) {
    const need = requiredCandidates(p);
    if (p.approved < need) out.push(`${p.title}: needs at least ${need} approved candidates (has ${p.approved})`);
    else if (p.max_candidates != null && p.approved > p.max_candidates) out.push(`${p.title}: allows at most ${p.max_candidates} candidates (has ${p.approved})`);
    if (p.no_region) out.push(`${p.title}: every candidate needs a region. Choose one for ${p.no_region}`);
    if (p.approved < p.min_picks) out.push(`${p.title}: voters must pick at least ${p.min_picks}, but only ${p.approved} candidates are approved`);
    if (p.region_rule_min != null && p.outside < p.region_rule_min) {
      out.push(`${p.title}: the rule "${regionRuleText({ minOutside: p.region_rule_min, regionName: p.rule_region })}" cannot be met: only ${p.outside} approved candidate${p.outside === 1 ? ' is' : 's are'} outside ${p.rule_region}`);
    }
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
  /** How many a voter may pick, the label the ballot shows ("Choose 4" / "Choose up to 4"), and the optional region rule (as data, plus its generated sentence). */
  min_picks: number; max_picks: number; choose_label: string;
  region_rule: { min_outside: number; region_id: string; region: string; text: string } | null;
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
    `SELECT p.*, rg.name AS rule_region,
            count(k.id) FILTER (WHERE k.status = 'approved' AND NOT k.is_abstain)::int AS approved,
            count(k.id) FILTER (WHERE k.status = 'submitted')::int AS submitted,
            count(k.id) FILTER (WHERE k.status = 'rejected')::int AS rejected,
            count(k.id) FILTER (WHERE k.status = 'withdrawn')::int AS withdrawn,
            count(k.id) FILTER (WHERE k.status = 'invited')::int AS invited
       FROM positions p LEFT JOIN candidates k ON k.position_id = p.id LEFT JOIN regions rg ON rg.id = p.region_rule_region_id
      WHERE p.campaign_id = $1 GROUP BY p.id, rg.name ORDER BY p.sort_order, p.created_at`, [c.id]);
  const results = c.status === 'closed' ? await getResults(db, c.id) : null;
  return rows.map((p) => {
    const res = results?.positions.find((x) => x.id === p.id);
    return {
      id: p.id, title: p.title, description: p.description, sort_order: p.sort_order, seats: p.seats, rule_text: p.rule_text,
      min_picks: p.min_picks, max_picks: p.max_picks, choose_label: chooseLabel(p.min_picks, p.max_picks),
      region_rule: p.region_rule_min == null ? null : { min_outside: p.region_rule_min, region_id: p.region_rule_region_id, region: p.rule_region, text: regionRuleText({ minOutside: p.region_rule_min, regionName: p.rule_region }) },
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

