import type { Queryable } from '../db.js';

/**
 * Append-only audit entry. NEVER put candidate ids, ballot data or anything that could link a voter
 * to a candidate in `details`. Vote casting itself is deliberately not audited per-voter.
 */
export async function audit(
  db: Queryable, actorOid: string | null, action: string, campaignId: string | null, details: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    'INSERT INTO audit_log (actor_oid, action, campaign_id, details) VALUES ($1, $2, $3, $4)',
    [actorOid, action, campaignId, JSON.stringify(details)],
  );
}
