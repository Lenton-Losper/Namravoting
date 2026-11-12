import type pg from 'pg';
import type { ParsedMember } from './parse.js';

/**
 * Matches Umoja members to their Microsoft (Entra) accounts. PRIVACY: member names are read from the HR file and used only
 * in memory while matching. What the database keeps is the account's object id (oid) and mail address, never a name.
 */
export type MatchStatus = 'matched' | 'not_found' | 'ambiguous' | 'conflict';

export interface GraphUser { id: string; displayName: string | null; givenName: string | null; surname: string | null; mail: string | null; userPrincipalName: string | null }
/** How the single match was made. `exact_name`: the whole display name equals the member's name; `given_surname`: first name and surname fields do. */
export type MatchBasis = 'exact_name' | 'given_surname';
export interface MatchResult {
  code: string; name: string; active: boolean; status: MatchStatus; oid: string | null; email: string | null; candidates: number;
  basis?: MatchBasis | null;
  /** Ambiguous only: the mail addresses of the accounts that all fit the name, for the human reviewer (local report only). */
  alternatives?: string[];
}
export interface MatchCounts { matched: number; not_found: number; ambiguous: number; conflict: number }

// ---------------------------------------------------------------------------------------------------------------- names

/** lower-case, trim, strip accents, hyphens/apostrophes/punctuation -> single spaces. "Smith-Jones" === "smith jones". */
export function normalizeName(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every run of consecutive tokens ("van der Merwe" -> "van", "van der", "van der merwe", "der", ...). */
function spans(tokens: string[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < tokens.length; i++) for (let j = i + 1; j <= tokens.length; j++) out.add(tokens.slice(i, j).join(' '));
  return out;
}

/**
 * Strong match: the account's givenName equals the member's first name AND its surname equals any of the member's other
 * names (so middle names are fine); or the full displayName equals the full name. Anything weaker is not a match.
 */
export function matchBasis(memberName: string, u: GraphUser): MatchBasis | null {
  const full = normalizeName(memberName);
  if (!full) return null;
  if (normalizeName(u.displayName) === full) return 'exact_name';
  const tokens = full.split(' ');
  if (tokens.length < 2) return null;
  const given = normalizeName(u.givenName);
  const surname = normalizeName(u.surname);
  return given !== '' && surname !== '' && given === tokens[0] && spans(tokens.slice(1)).has(surname) ? 'given_surname' : null;
}
export const isStrongMatch = (memberName: string, u: GraphUser): boolean => matchBasis(memberName, u) !== null;

const clean = (s: string) => s.replace(/["\\]/g, '').trim();

/** Graph $search expressions to try, most specific first: first name AND last token, then first name AND each other name. */
export function searchQueries(memberName: string): string[] {
  const raw = memberName.trim().split(/\s+/).map(clean).filter(Boolean);
  if (raw.length === 0) return [];
  const term = (t: string) => t.split(/[-‐‑–]/).map(clean).filter(Boolean).map((p) => `"displayName:${p}"`);
  if (raw.length === 1) return [term(raw[0]).join(' AND ')];
  const first = raw[0];
  const others = raw.slice(1);
  const order = [others[others.length - 1], ...others.slice(0, -1)];
  return [...new Set(order)].map((o) => [...term(first), ...term(o)].join(' AND '));
}

// ---------------------------------------------------------------------------------------------------------------- Graph

export interface GraphDeps {
  token: string;                       // held in memory only; never logged
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  graphBase?: string;
  ratePerSec?: number;                 // default 5 requests/second
  maxRetries?: number;                 // 429 / 503 retries per request
}

export class GraphError extends Error {}
/** The low-level cause code of a failed fetch (e.g. ECONNRESET, ENOTFOUND); never a URL or header. */
export const netCode = (e: unknown): string => String((e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code ?? 'unknown');

/** A small client: throttled to ratePerSec, honours Retry-After on 429. Error messages never contain the token or response bodies. */
export function createGraphSearch(d: GraphDeps): (query: string) => Promise<GraphUser[]> {
  const f = d.fetch ?? fetch;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = d.now ?? Date.now;
  const base = (d.graphBase ?? 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
  const gap = 1000 / (d.ratePerSec ?? 5);
  const maxRetries = d.maxRetries ?? 6;
  let nextSlot = 0;
  const throttle = async () => {
    const t = now();
    const wait = Math.max(0, nextSlot - t);
    nextSlot = Math.max(t, nextSlot) + gap;
    if (wait > 0) await sleep(wait);
  };
  return async (query) => {
    const url = `${base}/users?$search=${encodeURIComponent(query)}&$select=id,displayName,givenName,surname,mail,userPrincipalName&$top=50`;
    for (let attempt = 0; ; attempt++) {
      await throttle();
      let r: Response;
      try {
        r = await f(url, { headers: { authorization: `Bearer ${d.token}`, ConsistencyLevel: 'eventual', accept: 'application/json' } });
      } catch (e) {
        // A dropped connection / DNS blip must not kill a long run: back off and retry, then fail with the cause code only.
        if (attempt < maxRetries) { await sleep(Math.min(30_000, 2 ** attempt * 1000)); continue; }
        throw new GraphError(`Graph /users search failed: network error (${netCode(e)})`);
      }
      if (r.ok) {
        const j = (await r.json()) as { value?: unknown };
        return (Array.isArray(j.value) ? j.value : []).filter((u): u is GraphUser => !!u && typeof (u as GraphUser).id === 'string');
      }
      if ((r.status === 429 || r.status === 503) && attempt < maxRetries) {
        const ra = Number(r.headers.get('retry-after'));
        const waitMs = Math.min(60_000, (Number.isFinite(ra) && ra > 0 ? ra : 2 ** attempt) * 1000);
        nextSlot = Math.max(nextSlot, now() + waitMs);   // everything behind this request waits too
        await sleep(waitMs);
        continue;
      }
      throw new GraphError(`Graph /users search failed with HTTP ${r.status}`);
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------- matching

const emailOf = (u: GraphUser) => (u.mail ?? u.userPrincipalName ?? '').trim().toLowerCase() || null;

export async function matchMembers(
  members: ParsedMember[], search: (q: string) => Promise<GraphUser[]>, onProgress?: (done: number, total: number) => void,
): Promise<MatchResult[]> {
  const results: MatchResult[] = [];
  let done = 0;
  for (const m of members) {
    const name = m.name ?? '';
    const found = new Map<string, GraphUser>();
    for (const q of searchQueries(name)) {
      for (const u of await search(q)) if (isStrongMatch(name, u)) found.set(u.id.toLowerCase(), u);
      if (found.size > 0) break;   // the most specific query that finds anyone decides; we never widen to pick between people
    }
    const hits = [...found.values()];
    const base = { code: m.code, name, active: m.active, candidates: hits.length };
    if (hits.length === 1) results.push({ ...base, status: 'matched', oid: hits[0].id.toLowerCase(), email: emailOf(hits[0]), basis: matchBasis(name, hits[0]) });
    else results.push({ ...base, status: hits.length === 0 ? 'not_found' : 'ambiguous', oid: null, email: null, basis: null, alternatives: hits.map(emailOf).filter((x): x is string => !!x).sort() });
    onProgress?.(++done, members.length);
  }
  // The same account claimed by two different codes: neither can be trusted.
  const byOid = new Map<string, MatchResult[]>();
  for (const r of results) if (r.status === 'matched' && r.oid) byOid.set(r.oid, [...(byOid.get(r.oid) ?? []), r]);
  for (const group of byOid.values()) if (group.length > 1) for (const r of group) { r.status = 'conflict'; r.oid = null; r.email = null; }
  return results;
}

export function countResults(results: MatchResult[]): MatchCounts {
  const c: MatchCounts = { matched: 0, not_found: 0, ambiguous: 0, conflict: 0 };
  for (const r of results) c[r.status]++;
  return c;
}

// ---------------------------------------------------------------------------------------------------------------- output

const csvCell = (v: string | number): string => {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;   // spreadsheet formula injection
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * The local report (gitignored data/ folder): the ONLY place names and emails are written. It is also the worksheet for the human
 * confirmation (SEC-22): matching never writes to the database. A person reads it, puts `yes` in the `confirm` column of every
 * row they have checked, and only those rows are applied (applyConfirmedReport).
 */
export const REPORT_HEADER = ['code', 'member_name', 'status', 'matched_email', 'oid', 'basis', 'candidates', 'other_candidates', 'confirm'];
export function reportCsv(results: MatchResult[]): string {
  const rows = results.map((r) => [r.code, r.name, r.status, r.email ?? '', r.oid ?? '', r.basis ?? '', r.candidates, (r.alternatives ?? []).join(' | '), ''].map(csvCell).join(','));
  return [REPORT_HEADER.join(','), ...rows].join('\n') + '\n';
}

/** Minimal RFC-4180 reader (quoted fields, doubled quotes, newlines inside quotes). */
function readCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some((c) => c !== '')) rows.push(row); row = []; }
    else cur += ch;
  }
  row.push(cur); if (row.some((c) => c !== '')) rows.push(row);
  return rows;
}

export interface ConfirmedReport { confirmed: MatchResult[]; ignored: number; rejected: { code: string; why: string }[] }
const YES = new Set(['yes', 'y', 'true', '1', 'confirmed']);
const OID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[A-Z]{3}[0-9]{4}$/;

/**
 * Reads the reviewed report. A row counts only if a human wrote `yes` in `confirm` AND its status is `matched` AND it carries a
 * well-formed code and account id. Ambiguous, not-found and conflicting rows are never applied, whatever the confirm column says.
 * Two confirmed rows that claim the same account or the same code are both rejected. Names are never returned.
 */
export function parseConfirmedReport(csv: string): ConfirmedReport {
  const rows = readCsv(csv.replace(/^\uFEFF/, ''));
  const head = (rows.shift() ?? []).map((h) => h.trim().toLowerCase());
  const col = (n: string) => head.indexOf(n);
  for (const need of ['code', 'status', 'oid', 'confirm']) if (col(need) < 0) throw new Error(`The report has no "${need}" column. Use the file written by umoja:match.`);
  const out: MatchResult[] = []; const rejected: { code: string; why: string }[] = []; let ignored = 0;
  for (const r of rows) {
    const get = (n: string) => (r[col(n)] ?? '').trim();
    if (!YES.has(get('confirm').toLowerCase())) { ignored++; continue; }
    const code = get('code').toUpperCase(); const oid = get('oid').toLowerCase(); const email = get('matched_email').toLowerCase() || null;
    if (get('status') !== 'matched') { rejected.push({ code, why: 'only a matched row can be confirmed' }); continue; }
    if (!CODE_RE.test(code)) { rejected.push({ code, why: 'not a valid employee code' }); continue; }
    if (!OID_RE.test(oid)) { rejected.push({ code, why: 'missing or malformed account id' }); continue; }
    out.push({ code, name: '', active: true, status: 'matched', oid, email, candidates: 1 });
  }
  const dupOid = new Map<string, number>(); const dupCode = new Map<string, number>();
  for (const r of out) { dupOid.set(r.oid!, (dupOid.get(r.oid!) ?? 0) + 1); dupCode.set(r.code, (dupCode.get(r.code) ?? 0) + 1); }
  const confirmed: MatchResult[] = [];
  for (const r of out) {
    if ((dupOid.get(r.oid!) ?? 0) > 1) rejected.push({ code: r.code, why: 'the same account is confirmed for more than one member' });
    else if ((dupCode.get(r.code) ?? 0) > 1) rejected.push({ code: r.code, why: 'the same member appears twice' });
    else confirmed.push(r);
  }
  return { confirmed, ignored, rejected };
}

// ---------------------------------------------------------------------------------------------------------------- database

export interface ApplySummary extends MatchCounts { updated: number; not_in_db: number }

/**
 * Writes entra_oid + email for `matched` rows only, in ONE transaction, and an audit entry with counts only.
 * Run with the OWNER role (the app role has SELECT only on umoja_members). Names never reach this function's queries.
 */
export async function applyMatches(client: pg.Client | pg.PoolClient, results: MatchResult[]): Promise<ApplySummary> {
  const matched = results.filter((r) => r.status === 'matched' && r.oid);
  const codes = matched.map((r) => r.code);
  const oids = matched.map((r) => r.oid!);
  const emails = matched.map((r) => r.email);
  await client.query('BEGIN');
  try {
    // An account moves with its new code: free the oid from any other row first (the column is UNIQUE).
    await client.query('UPDATE umoja_members SET entra_oid = NULL, email = NULL WHERE entra_oid = ANY($1::uuid[]) AND employee_code <> ALL($2::text[])', [oids, codes]);
    const upd = await client.query(
      `UPDATE umoja_members m SET entra_oid = v.oid, email = v.email
         FROM unnest($1::text[], $2::uuid[], $3::text[]) AS v(code, oid, email) WHERE m.employee_code = v.code`, [codes, oids, emails]);
    const summary: ApplySummary = { ...countResults(results), updated: upd.rowCount ?? 0, not_in_db: matched.length - (upd.rowCount ?? 0) };
    await client.query("INSERT INTO audit_log (actor_oid, action, details) VALUES (NULL, 'umoja.match', $1)", [JSON.stringify(summary)]);
    await client.query('COMMIT');
    return summary;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

/** Applies ONLY the rows a human confirmed in the reviewed report (SEC-22). Owner role. Refuses an empty confirmation. */
export async function applyConfirmedReport(client: pg.Client | pg.PoolClient, csv: string): Promise<ApplySummary & { ignored: number; rejected: number }> {
  const r = parseConfirmedReport(csv);
  if (r.confirmed.length === 0) throw new Error(`No row is confirmed. Put "yes" in the confirm column of every row you have checked (${r.rejected.length} row(s) were rejected, ${r.ignored} not confirmed).`);
  const summary = await applyMatches(client, r.confirmed);
  return { ...summary, ignored: r.ignored, rejected: r.rejected.length };
}
