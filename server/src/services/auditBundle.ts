import type { Queryable } from '../db.js';
import type { CampaignRow } from './campaigns.js';
import { getResults, verifySeal } from './campaigns.js';
import { buildCsv, buildPdf, buildXlsx, csvCell, fmtWindhoek, gatherExport } from './resultsExport.js';
import { zip } from './zip.js';

/**
 * The audit bundle for Umoja leadership (business-logic item 9): ONE download that shows what the result is AND how it was reached.
 *   results.pdf, results.xlsx, results.csv   the result, turnout against the frozen voter count, tie / quorum / abstentions / withdrawals, every
 *                                            reset, early close and edit with its reason, the seal fingerprint
 *   audit-log.csv                            every audit entry of this campaign with the hashes, in the exact form the chain was computed
 *   verify-audit.mjs                         a small script (Node 18+) that recomputes each entry's hash from audit-log.csv: anyone can run it
 *   README.txt                               what is in the bundle, the chain status at the time of export, and how to verify it
 * Closed campaigns only (SEC-01). Contains no vote and no receipt: nothing that says who voted or for whom.
 */

export const VERIFY_SCRIPT = `// Recomputes the hash of every entry in audit-log.csv, exactly as the NamRA Voting database does, and reports any entry that does not match.
//   node verify-audit.mjs [audit-log.csv]
// hash = SHA-256( prev_hash | seq | id | actor_oid | action | campaign_id | details | at_utc ), empty text for a missing value, then hex.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\\n') { row.push(cell.replace(/\\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell.replace(/\\r$/, '')); rows.push(row); }
  return rows;
}

const [head, ...rows] = parseCsv(readFileSync(process.argv[2] ?? 'audit-log.csv', 'utf8').replace(/^\\uFEFF/, '')).filter((r) => r.length > 1);
const col = (name) => head.indexOf(name);
const need = ['seq', 'id', 'at_utc', 'actor_oid', 'action', 'campaign_id', 'details', 'prev_hash', 'hash'];
for (const n of need) if (col(n) < 0) { console.error('audit-log.csv has no "' + n + '" column'); process.exit(2); }
let bad = 0;
for (const r of rows) {
  const v = (n) => r[col(n)] ?? '';
  const text = [v('prev_hash'), v('seq'), v('id'), v('actor_oid'), v('action'), v('campaign_id'), v('details'), v('at_utc')].join('|');
  const want = createHash('sha256').update(text, 'utf8').digest('hex');
  if (want !== v('hash')) { bad++; console.log('MISMATCH at entry ' + v('seq') + ' (' + v('action') + ')'); }
}
console.log(rows.length + ' entries checked, ' + bad + ' do not match.');
process.exit(bad ? 1 : 0);
`;

const csvLine = (cells: (string | number | null)[]) => cells.map((c) => csvCell(c == null ? '' : String(c))).join(',');

export async function buildAuditCsv(db: Queryable, campaignId: string): Promise<{ csv: string; entries: number; sealSeq: number | null }> {
  const { rows } = await db.query(
    `SELECT a.seq, a.id, to_char(a.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS at_utc, a.at, a.actor_oid, u.display_name AS actor, a.action, a.campaign_id,
            a.details::text AS details, a.prev_hash, a.hash
       FROM audit_log a LEFT JOIN users u ON u.entra_oid = a.actor_oid WHERE a.campaign_id = $1 ORDER BY a.seq`, [campaignId]);
  const head = ['seq', 'id', 'at_utc', 'at_windhoek', 'actor_oid', 'actor', 'action', 'campaign_id', 'details', 'prev_hash', 'hash'];
  const lines = [head.join(',')];
  let sealSeq: number | null = null;
  for (const r of rows) {
    lines.push(csvLine([r.seq, r.id, r.at_utc, fmtWindhoek(r.at), r.actor_oid, r.actor ?? (r.actor_oid ? '' : 'system'), r.action, r.campaign_id, r.details, r.prev_hash, r.hash]));
    if (String(r.action).startsWith('campaign.close')) sealSeq = Number(r.seq);
  }
  return { csv: '﻿' + lines.join('\r\n') + '\r\n', entries: rows.length, sealSeq };
}

export async function buildAuditBundle(db: Queryable, c: CampaignRow, generatedBy: string, now = new Date()): Promise<Buffer> {
  const data = await gatherExport(db, c, generatedBy, now);
  const results = await getResults(db, c.id);
  const seal = await verifySeal(db, c.id);
  const chain = (await db.query('SELECT audit_chain_verify() AS r')).rows[0].r as { ok: boolean; checked: number };
  const audit = await buildAuditCsv(db, c.id);
  const sealed = seal.sealed && !!seal.seal_hash;
  const readme = [
    `NamRA Voting: audit bundle`,
    `Campaign: ${c.title}`,
    `Generated: ${fmtWindhoek(now)} by ${generatedBy} (all times are Windhoek time, CAT, unless marked UTC)`,
    ``,
    `WHAT IS IN THIS BUNDLE`,
    `  results.pdf / results.xlsx / results.csv   The result: votes and percentages per candidate, turnout against the voter count frozen when voting`,
    `                                             started (${data.eligibleCount ?? 'not applicable: open to all staff'}), tie, quorum, abstentions, withdrawals, and the history of`,
    `                                             every reset, early close and edit after start, each with who, when and why.`,
    `  audit-log.csv                              Every audit entry about this campaign (${audit.entries} entries), with the hash of each.`,
    `  verify-audit.mjs                           Recomputes every entry's hash from audit-log.csv. Run:  node verify-audit.mjs audit-log.csv`,
    ``,
    `STATE OF THE RECORD AT THE TIME OF EXPORT`,
    `  Audit chain of the whole system:      ${chain.ok ? `INTACT (${chain.checked} entries, every hash links to the one before it)` : 'BROKEN: do not rely on this bundle until investigated'}`,
    `  Result sealed when voting closed:     ${sealed ? `yes, at ${fmtWindhoek(seal.sealed_at)}` : 'NO'}`,
    `  Seal fingerprint:                     ${seal.seal_hash ?? 'n/a'}`,
    `  Counters equal the sealed tallies:    ${seal.tallies_match === null ? 'n/a' : seal.tallies_match ? 'yes' : 'NO'}`,
    `  Receipts equal the sealed turnout:    ${seal.receipts_match === null ? 'n/a (receipts removed under the retention schedule, or none)' : seal.receipts_match ? 'yes' : 'NO'}`,
    `  Turnout:                              ${results.turnout.votes}${results.turnout.eligible == null ? '' : ` of ${results.turnout.eligible} eligible`}`,
    ``,
    `HOW TO VERIFY THE RESULT YOURSELF`,
    `  1. Run  node verify-audit.mjs audit-log.csv  (Node 18 or newer). Every entry's hash is recomputed from its own fields, so a changed, removed`,
    `     or re-ordered field shows as a MISMATCH. "0 do not match" means the entries are exactly as written.`,
    `  2. In audit-log.csv find the entry whose action starts with "campaign.close" (the last one is the one that sealed the result${audit.sealSeq ? `: entry ${audit.sealSeq}` : ''}).`,
    `     Its "hash" is the SEAL FINGERPRINT${seal.seal_hash ? ` (${seal.seal_hash})` : ''}. Its "details" lists the sealed tallies and turnout: they must equal results.csv.`,
    `  3. Each entry also carries "prev_hash", the hash of the entry before it in the system-wide chain. This bundle holds only this campaign's entries,`,
    `     so entries of other campaigns sit between them; the head of the whole chain is checked by the system ("Audit chain" above).`,
    ``,
    `WHAT THIS BUNDLE DOES NOT CONTAIN`,
    `  Who voted, and for whom. Votes are counted, never stored per voter: there is nothing here (or anywhere in the system) that links a person to a choice.`,
    ``,
  ].join('\r\n');
  return zip([
    { name: 'README.txt', data: Buffer.from(readme, 'utf8') },
    { name: 'results.pdf', data: await buildPdf(data) },
    { name: 'results.xlsx', data: await buildXlsx(data) },
    { name: 'results.csv', data: Buffer.from(buildCsv(c, results, seal), 'utf8') },
    { name: 'audit-log.csv', data: Buffer.from(audit.csv, 'utf8') },
    { name: 'verify-audit.mjs', data: Buffer.from(VERIFY_SCRIPT, 'utf8') },
  ], now);
}
