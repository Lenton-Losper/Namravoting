import type { Queryable } from '../db.js';
import { getConfig } from '../config.js';

/** Why a caller is (not) an active Umoja member. Only `member` grants access; the others are for server logs only. */
export type UmojaReason = 'member' | 'no_code' | 'unknown_code' | 'inactive';

/**
 * The single membership check, used by the ballot page, the vote transaction, My votes, photos and results.
 * A signed-in user is an active member if ANY of these holds:
 *   1. their Entra account id (oid) equals umoja_members.entra_oid (matched ahead of time by `npm run umoja:match`) - preferred;
 *   2. their employee code (users.employee_code, from the Entra employeeId at sign-in) is an active member's code;
 *   3. their email is in DEMO_MEMBER_EMAILS (demo override).
 * The oid and email come from the verified ID token (stored at sign-in / in the signed session), never from a request.
 */
export async function umojaReason(db: Queryable, voterOid: string): Promise<UmojaReason> {
  const { rows } = await db.query(
    `SELECT u.employee_code, u.email,
            m.active AS member_active, (m.entra_oid = u.entra_oid) AS by_oid
       FROM (SELECT $1::uuid AS oid) q
       LEFT JOIN users u ON u.entra_oid = q.oid
       LEFT JOIN umoja_members m ON m.entra_oid = q.oid OR (u.employee_code IS NOT NULL AND m.employee_code = u.employee_code)`, [voterOid]);
  const hits = rows.filter((r) => r.member_active !== null);
  if (hits.some((r) => r.member_active === true)) return 'member';
  const r = rows[0];
  if (r && r.email && demoMemberEmails().includes(String(r.email).toLowerCase())) {
    console.warn(`[umoja] member via DEMO_MEMBER_EMAILS user=${voterOid}`);
    return 'member';
  }
  if (hits.length > 0) return 'inactive';                 // matched to a member row that is not active
  if (!r || !r.employee_code) return 'no_code';
  return 'unknown_code';
}

/** The DEMO_MEMBER_EMAILS override list (empty unless AUTH_MODE=entra and the setting is non-empty). */
export const demoMemberEmails = (): string[] => getConfig().entra?.demoMemberEmails ?? [];

/** SQL boolean expression: is the user in the given parameter an active member? (for list queries) */
export const isActiveMemberSql = (oidParam: string): string => {
  // Entries are validated at config time (plain emails only), so embedding them as literals is safe.
  const demo = demoMemberEmails().map((e) => `'${e.replace(/'/g, "''")}'`).join(',');
  return `(EXISTS (SELECT 1 FROM umoja_members m WHERE m.active AND m.entra_oid = ${oidParam})
     OR EXISTS (SELECT 1 FROM users u JOIN umoja_members m ON m.employee_code = u.employee_code WHERE u.entra_oid = ${oidParam} AND m.active)
     OR EXISTS (SELECT 1 FROM users d WHERE d.entra_oid = ${oidParam} AND lower(d.email) = ANY(ARRAY[${demo}]::text[])))`;
};

export async function activeMemberCount(db: Queryable): Promise<number> {
  return (await db.query('SELECT count(*)::int AS n FROM umoja_members WHERE active')).rows[0].n as number;
}

/** Server-side log line so admins can help a member who was turned away. The voter never sees the reason. */
export function logNotMember(reason: Exclude<UmojaReason, 'member'>, campaignId: string, voterOid: string): void {
  console.warn(`[umoja] not_member reason=${reason} campaign=${campaignId} user=${voterOid}`);
}
