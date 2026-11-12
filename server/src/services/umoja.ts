import type { Queryable } from '../db.js';
import { getConfig } from '../config.js';
import { idTag } from '../logSafe.js';

/** Why a caller is (not) an active Umoja member. Only `member` grants access; the others are for server logs only. */
export type UmojaReason = 'member' | 'no_code' | 'unknown_code' | 'inactive';

export interface Standing {
  reason: UmojaReason;
  /** The identity a vote counts against (one vote per member, SEC-03). Set when reason is 'member'. */
  memberKey: string | null;
}

/**
 * The single membership check, used by the ballot page, the vote transaction, My votes, photos and results.
 *
 * Eligibility is checked against the campaign's SNAPSHOT (`campaign_voters`, taken when the campaign started, SEC-05), so a
 * later import or re-match cannot change who may vote. A draft has no snapshot yet and is checked against the live list
 * (preview only: nobody can vote in a draft).
 *
 * Order of evidence (SEC-03):
 *   1. the account id (oid) matched to a member ahead of time (`npm run umoja:match`): if it hits a member row, that row decides;
 *   2. otherwise the employee code (users.employee_code, from the Entra employeeId at sign-in);
 *   3. otherwise the email is in DEMO_MEMBER_EMAILS (demo override).
 * The member key is `code:<employee code>` for 1 and 2 (so two accounts of one member count as one voter) and `email:<address>` for 3.
 */
export async function umojaStanding(db: Queryable, voterOid: string, campaign: { id: string; status: string }): Promise<Standing> {
  const members = campaign.status === 'draft'
    ? 'SELECT employee_code AS member_code, entra_oid, active FROM umoja_members'
    : 'SELECT member_code, entra_oid, active FROM campaign_voters WHERE campaign_id = $2';
  const params: unknown[] = campaign.status === 'draft' ? [voterOid] : [voterOid, campaign.id];
  const { rows } = await db.query(
    `WITH members AS (${members})
     SELECT u.employee_code, u.email, m.member_code, m.active AS member_active, (m.entra_oid = q.oid) AS by_oid
       FROM (SELECT $1::uuid AS oid) q
       LEFT JOIN users u ON u.entra_oid = q.oid
       LEFT JOIN members m ON m.entra_oid = q.oid OR (u.employee_code IS NOT NULL AND m.member_code = u.employee_code)`, params);
  const hits = rows.filter((r) => r.member_code !== null);
  const byOid = hits.filter((r) => r.by_oid === true);
  const deciding = byOid.length > 0 ? byOid : hits;      // an account match beats a code match
  const active = deciding.find((r) => r.member_active === true);
  if (active) return { reason: 'member', memberKey: `code:${active.member_code}` };
  const r = rows[0];
  if (r && r.email && demoMemberEmails().includes(String(r.email).toLowerCase())) {
    console.warn(`[umoja] member via DEMO_MEMBER_EMAILS user=${idTag(voterOid)}`);
    return { reason: 'member', memberKey: `email:${String(r.email).toLowerCase()}` };
  }
  if (deciding.length > 0) return { reason: 'inactive', memberKey: null };
  if (!r || !r.employee_code) return { reason: 'no_code', memberKey: null };
  return { reason: 'unknown_code', memberKey: null };
}

/** The DEMO_MEMBER_EMAILS override list (empty unless AUTH_MODE=entra and the setting is non-empty). */
export const demoMemberEmails = (): string[] => getConfig().entra?.demoMemberEmails ?? [];

/**
 * SQL boolean: is the user in `oidParam` an active member for the campaign row/alias `campaignExpr` (e.g. `c.id`)? Uses the
 * snapshot, same precedence as umojaStanding: an account match decides, the employee code is only used without one.
 */
export const isSnapshotMemberSql = (campaignIdExpr: string, oidParam: string): string => {
  // Entries are validated at config time (plain emails only), so embedding them as literals is safe.
  const demo = demoMemberEmails().map((e) => `'${e.replace(/'/g, "''")}'`).join(',');
  return `(EXISTS (SELECT 1 FROM campaign_voters v WHERE v.campaign_id = ${campaignIdExpr} AND v.active AND v.entra_oid = ${oidParam})
     OR (NOT EXISTS (SELECT 1 FROM campaign_voters v WHERE v.campaign_id = ${campaignIdExpr} AND v.entra_oid = ${oidParam})
         AND EXISTS (SELECT 1 FROM users u JOIN campaign_voters v ON v.member_code = u.employee_code
                      WHERE u.entra_oid = ${oidParam} AND v.campaign_id = ${campaignIdExpr} AND v.active))
     OR EXISTS (SELECT 1 FROM users d WHERE d.entra_oid = ${oidParam} AND lower(d.email) = ANY(ARRAY[${demo}]::text[])))`;
};

/** Live count of active members (used before a campaign starts). */
export async function activeMemberCount(db: Queryable): Promise<number> {
  return (await db.query('SELECT count(*)::int AS n FROM umoja_members WHERE active')).rows[0].n as number;
}

/** Active members in a campaign's frozen voter list. */
export async function snapshotActiveCount(db: Queryable, campaignId: string): Promise<number> {
  return (await db.query('SELECT count(*)::int AS n FROM campaign_voters WHERE campaign_id = $1 AND active', [campaignId])).rows[0].n as number;
}

/** Freezes the voter list for a campaign: identities only (employee code, matched account id, active flag). */
export async function snapshotVoters(db: Queryable, campaignId: string): Promise<number> {
  const r = await db.query(
    'INSERT INTO campaign_voters (campaign_id, member_code, entra_oid, active) SELECT $1, employee_code, entra_oid, active FROM umoja_members ON CONFLICT DO NOTHING', [campaignId]);
  return r.rowCount ?? 0;
}

/** The identity a live (not campaign-bound) lookup would use: for "has this person voted" in lists. Null if unknown. */
export async function liveMemberKey(db: Queryable, voterOid: string): Promise<string | null> {
  const { rows } = await db.query(
    `SELECT m.employee_code FROM users u
       JOIN umoja_members m ON m.entra_oid = u.entra_oid OR (u.employee_code IS NOT NULL AND m.employee_code = u.employee_code)
      WHERE u.entra_oid = $1 ORDER BY (m.entra_oid = u.entra_oid) DESC, m.active DESC LIMIT 1`, [voterOid]);
  return rows[0] ? `code:${rows[0].employee_code}` : null;
}

/** Server-side log line so admins can help a member who was turned away. The voter never sees the reason. The account is a short one-way tag (SEC-19). */
export function logNotMember(reason: Exclude<UmojaReason, 'member'>, campaignId: string, voterOid: string): void {
  console.warn(`[umoja] not_member reason=${reason} campaign=${campaignId} user=${idTag(voterOid)}`);
}
