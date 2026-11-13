import crypto from 'node:crypto';
import type { Queryable } from '../db.js';
import { getPool } from '../db.js';
import { audit } from './audit.js';
import { getResults, verifySeal } from './campaigns.js';
import { getStorage, type PhotoStorage } from './storage.js';

/**
 * Business-logic item 6: when a campaign closes, a copy of its SEALED RESULT is written to the R2 bucket (disk in development), so the
 * result exists outside the database. It holds counters and the seal fingerprint only: no voter, no receipt, no personal data.
 * One file per close (`sealed-<campaign>-<audit seq>.json`; a reset and a second close gets its own), kept indefinitely.
 */

export interface SealedBackup { key: string; body: Buffer; sha256: string }

export async function buildSealedBackup(db: Queryable, campaignId: string, now = new Date()): Promise<SealedBackup | null> {
  const seal = await verifySeal(db, campaignId);
  if (!seal.sealed || seal.seal_seq === null || !seal.seal_hash) return null;
  const c = (await db.query('SELECT id, title, eligibility, status FROM campaigns WHERE id = $1', [campaignId])).rows[0];
  if (!c || c.status !== 'closed') return null;
  const results = await getResults(db, campaignId);
  const head = (await db.query('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1')).rows[0];
  const doc = {
    format: 1,
    note: 'Sealed result of a NamRA Voting campaign. Counters and the seal fingerprint only: no voter and no receipt.',
    campaign: { id: c.id, title: c.title, eligibility: c.eligibility },
    sealed: { audit_seq: seal.seal_seq, fingerprint: seal.seal_hash, at: seal.sealed_at },
    turnout: results.turnout,
    tallies: results.candidates.map((x) => ({ position: results.positions.find((p) => p.id === x.position_id)?.title, name: x.name, region: x.region ?? undefined, votes: x.votes, ...(x.is_abstain ? { abstain: true } : {}), ...(x.withdrawn ? { withdrawn: true } : {}) })),
    // One entry per position with its own seal fingerprint: a position's result can be checked on its own.
    positions: results.positions.map((p) => ({ title: p.title, turnout: p.turnout.votes, winners: p.winners.map((w) => w.name), tie: p.tie ? p.tie.names : null, fingerprint: seal.positions.find((x) => x.position_id === p.id)?.fingerprint ?? null })),
    tie: results.tie ? results.tie.names : null,
    audit_head_when_written: head ? { seq: Number(head.seq), hash: head.hash } : null,
    how_to_verify: 'The fingerprint is the hash of audit entry <audit_seq> of this campaign in the NamRA Voting audit log (Verify results integrity on the campaign page, or audit_chain_verify() in the database). The tallies must equal the "tallies" recorded in that entry.',
    written_at: now.toISOString(),
  };
  const body = Buffer.from(JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return { key: `sealed-${campaignId}-${seal.seal_seq}.json`, body, sha256: crypto.createHash('sha256').update(body).digest('hex') };
}

/**
 * Writes the copy and records it in the audit log. NEVER throws: a storage problem must not undo or block a close; it is recorded
 * (`result.backup_failed`) and the monitoring / the operator can retry with `npm run` ... or simply close-verify again.
 */
export async function backupSealedResult(campaignId: string, storage?: PhotoStorage): Promise<boolean> {
  try {
    const b = await buildSealedBackup(getPool(), campaignId);
    if (!b) return false;
    try { await (storage ?? getStorage()).put(b.key, b.body, 'application/json'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }   // disk storage refuses to overwrite: it is already there
    await audit(getPool(), null, 'result.backed_up', campaignId, { key: b.key, sha256: b.sha256 });
    return true;
  } catch (e) {
    console.warn(`[backup] sealed result of ${campaignId} was not copied: ${(e as Error).message}`);
    await audit(getPool(), null, 'result.backup_failed', campaignId, { error: (e as Error).message.slice(0, 200) }).catch(() => undefined);
    return false;
  }
}
