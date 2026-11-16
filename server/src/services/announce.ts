import crypto from 'node:crypto';
import type { Queryable } from '../db.js';
import { getResults, verifySeal, type CampaignRow } from './campaigns.js';
import { WINNERS_EMAIL } from './notify.js';

/**
 * "Announce winners": the only way voters ever learn a result. Voters never see results, counts, tallies or turnout; after the close the
 * creator (or a co-admin) announces the WINNERS, by name, once. The announcement is stored with the campaign and shown only to people who
 * have a receipt for it. It carries no counts of any kind.
 */

export interface AnnouncedPosition { title: string; winners: string[] }
export interface Announcement { text: string; positions: AnnouncedPosition[] }

export type BlockCode = 'not_closed' | 'tied' | 'integrity_failed' | 'receipts_purged' | 'already_announced';
export interface AnnounceBlock { code: BlockCode; message: string; positions?: string[] }

export interface AnnouncePreview {
  /** The campaign is closed, so there is something to announce. */
  available: boolean;
  announced: { at: Date; by: string | null } | null;
  positions: { id: string; title: string; seats: number; winners: string[]; tie: string[] | null }[];
  /** The text that will be announced, and that "Copy announcement text" copies. Names only. */
  text: string;
  /** Reasons the announcement cannot be made now (empty = it can). */
  blocks: AnnounceBlock[];
  /** Turnout is below the quorum: allowed only with an explicit acknowledgement. */
  below_quorum: { votes: number; needed: number | null; percent: number } | null;
  /** Delivery by email is not built yet (a disabled stub, see services/notify.ts). */
  email: { available: false; reason: string };
}

export const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/** Plain text, the same for everyone: no counts, no percentages, no turnout, no receipt codes. */
export function announcementText(title: string, positions: AnnouncedPosition[]): string {
  const lines = positions.map((p) => `- ${p.title}: ${p.winners.length ? p.winners.join(', ') : 'no winner (no votes were cast)'}`);
  return [`Result: ${title}`, '', `Voting has closed. ${positions.length === 1 ? 'The winner is:' : 'The winners are:'}`, ...lines, '', 'Thank you to everyone who voted.', 'NamRA Voting'].join('\n');
}

export async function previewAnnouncement(db: Queryable, c: Pick<CampaignRow, 'id' | 'title' | 'status'>): Promise<AnnouncePreview> {
  const meta = (await db.query(
    `SELECT c.winners_announced_at AS at, u.display_name AS by, c.receipts_purged_at FROM campaigns c LEFT JOIN users u ON u.entra_oid = c.winners_announced_by WHERE c.id = $1`, [c.id])).rows[0];
  const announced = meta?.at ? { at: meta.at as Date, by: (meta.by as string | null) ?? null } : null;
  const email = { available: false as const, reason: WINNERS_EMAIL.reason };
  if (c.status !== 'closed') {
    return { available: false, announced, positions: [], text: '', blocks: [{ code: 'not_closed', message: 'Winners can only be announced after the campaign is closed' }], below_quorum: null, email };
  }
  const results = await getResults(db, c.id);
  const positions = results.positions.map((p) => ({
    id: p.id, title: p.title, seats: p.seats ?? 1,
    winners: (p.winners ?? []).map((w) => w.name),
    tie: p.tie ? p.tie.names : null,
  }));
  const blocks: AnnounceBlock[] = [];
  if (announced) blocks.push({ code: 'already_announced', message: 'The winners have already been announced' });
  const tied = positions.filter((p) => p.tie);
  if (tied.length) blocks.push({ code: 'tied', message: 'Tied: create a run-off', positions: tied.map((p) => p.title) });
  const seal = await verifySeal(db, c.id);
  if (seal.sealed && (!seal.chain_ok || seal.tallies_match === false || seal.receipts_match === false)) {
    blocks.push({ code: 'integrity_failed', message: 'The result no longer matches what was sealed when the campaign closed. Run "Verify results integrity" and investigate before announcing.' });
  }
  if (meta?.receipts_purged_at) blocks.push({ code: 'receipts_purged', message: 'The personal data of this campaign was removed, so nobody could be shown the announcement' });
  const q = results.quorum;
  return {
    available: true, announced, positions,
    text: tied.length ? '' : announcementText(c.title, positions.map((p) => ({ title: p.title, winners: p.winners }))),   // no text while a position is tied
    blocks,
    below_quorum: q && q.met === false ? { votes: q.votes, needed: q.needed, percent: q.percent } : null,
    email,
  };
}
