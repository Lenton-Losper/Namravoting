import type { Queryable } from '../db.js';
import { getConfig } from '../config.js';
import { NAMRA_DOMAIN } from '../domain/eligibility.js';

/**
 * Voters named on an email list (eligibility = 'list').
 *
 * With Microsoft sign-in (AUTH_MODE=entra) an address is bound to the ACCOUNT the first time that person signs in: `voter_oid` is set once
 * (bindListedVoter). From then on the account decides, not the address, so an address that is renamed, or handed to a new colleague, does
 * not carry the old person's right to vote. A row that is not bound yet is matched by address (the person has not signed in since).
 * In the other modes (typed-email demo, dev, Access) the accounts are not real Microsoft identities, so nothing is bound and the address decides.
 */
const bindsToAccount = (): boolean => getConfig().authMode === 'entra';

/** SQL boolean: is the account in `oidParam` (with address `emailParam`) on the list of the campaign `campaignIdExpr`? */
export const isListedSql = (campaignIdExpr: string, oidParam: string, emailParam: string): string =>
  bindsToAccount()
    ? `EXISTS (SELECT 1 FROM eligible_voters e WHERE e.campaign_id = ${campaignIdExpr} AND (e.voter_oid = ${oidParam}::uuid OR (e.voter_oid IS NULL AND e.voter_email = ${emailParam})))`
    : `EXISTS (SELECT 1 FROM eligible_voters e WHERE e.campaign_id = ${campaignIdExpr} AND e.voter_email = ${emailParam})`;

export async function isListed(db: Queryable, campaignId: string, oid: string, email: string): Promise<boolean> {
  // `me` mentions every parameter, so the query is valid whichever mode decides (the account id is unused outside entra mode).
  const { rowCount } = await db.query(`SELECT 1 FROM (SELECT $2::uuid AS oid) me WHERE ${isListedSql('$1::uuid', '$2', '$3')}`, [campaignId, oid, email.toLowerCase()]);
  return (rowCount ?? 0) > 0;
}

/** Entra sign-in: bind every not-yet-bound row that carries this person's address to their account. Returns how many rows were bound. */
export async function bindListedVoter(db: Queryable, oid: string, email: string): Promise<number> {
  const r = await db.query('UPDATE eligible_voters SET voter_oid = $1 WHERE voter_email = $2 AND voter_oid IS NULL', [oid, email.trim().toLowerCase()]);
  return r.rowCount ?? 0;
}

export interface ListSummary {
  count: number;
  /** Marked as having left (retention): still counted, so the eligible count and the quorum do not move. */
  left: number;
  /** Listed addresses that are not @namra.org.na (usually a typo). */
  not_namra: string[];
  /** Listed addresses nobody has signed in with yet (with Microsoft sign-in: never matched a Microsoft account). */
  never_signed_in: string[];
  /** SHA-256 of the sorted list (eligible_list_sha256): the same value the audit trail records. */
  sha256: string;
}

/**
 * What an admin should know about a voter list. Leavers are not reported as "never signed in" (they have, once). With Microsoft sign-in an
 * address counts as matched when it is bound to an account, or when an account that signed in through Microsoft has it. In the other modes any
 * account with that address counts.
 */
export async function listSummary(db: Queryable, campaignId: string): Promise<ListSummary> {
  const entra = bindsToAccount();
  const rows = (await db.query(
    `SELECT e.voter_email AS email, e.left_at IS NOT NULL AS left,
            (e.voter_oid IS NOT NULL OR EXISTS (SELECT 1 FROM users u WHERE lower(u.email) = e.voter_email AND (NOT $2::boolean OR u.entra_signin_at IS NOT NULL))) AS matched
       FROM eligible_voters e WHERE e.campaign_id = $1 ORDER BY e.voter_email COLLATE "C"`, [campaignId, entra])).rows as { email: string; left: boolean; matched: boolean }[];
  const sha = (await db.query('SELECT eligible_list_sha256($1) AS h', [campaignId])).rows[0].h as string;
  return {
    count: rows.length, left: rows.filter((r) => r.left).length, sha256: sha,
    not_namra: rows.filter((r) => !r.email.endsWith('@' + NAMRA_DOMAIN)).map((r) => r.email),
    never_signed_in: rows.filter((r) => !r.left && !r.matched).map((r) => r.email),
  };
}
