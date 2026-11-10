import type { Queryable } from '../db.js';

/** Why a caller is (not) an active Umoja member. Only `member` grants access; the others are for server logs only. */
export type UmojaReason = 'member' | 'no_code' | 'unknown_code' | 'inactive';

/**
 * The single membership check, used by the ballot page, the vote transaction, My votes and photos.
 * Reads users.employee_code (set by the auth layer at login) - never anything the request supplies.
 */
export async function umojaReason(db: Queryable, voterOid: string): Promise<UmojaReason> {
  const { rows } = await db.query(
    `SELECT u.employee_code, m.active
       FROM users u LEFT JOIN umoja_members m ON m.employee_code = u.employee_code
      WHERE u.entra_oid = $1`, [voterOid]);
  const r = rows[0];
  if (!r || !r.employee_code) return 'no_code';
  if (r.active === null) return 'unknown_code';
  return r.active ? 'member' : 'inactive';
}

/** SQL boolean expression: is the user in the given parameter an active member? (for list queries) */
export const isActiveMemberSql = (oidParam: string): string =>
  `EXISTS (SELECT 1 FROM users u JOIN umoja_members m ON m.employee_code = u.employee_code WHERE u.entra_oid = ${oidParam} AND m.active)`;

export async function activeMemberCount(db: Queryable): Promise<number> {
  return (await db.query('SELECT count(*)::int AS n FROM umoja_members WHERE active')).rows[0].n as number;
}

/** Server-side log line so admins can help a member who was turned away. The voter never sees the reason. */
export function logNotMember(reason: Exclude<UmojaReason, 'member'>, campaignId: string, voterOid: string): void {
  console.warn(`[umoja] not_member reason=${reason} campaign=${campaignId} user=${voterOid}`);
}
