import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { Queryable } from '../db.js';
import { standing } from '../domain/results.js';
import { NAMRA_LOGO_JPEG } from './logo.js';
import { getNotices, getResults, verifySeal, type CampaignRow, type ResultsPayload, type SealCheck } from './campaigns.js';

/**
 * Excel and PDF exports of a CLOSED campaign's result (SEC-01: the route refuses open campaigns; this module only formats).
 * Everything user-supplied (titles, descriptions, candidate names, reasons, display names) goes through `safeCell` before it
 * reaches a spreadsheet, so a candidate called `=HYPERLINK(...)` can never run as a formula (CSV injection / "formula injection").
 */

const WINDHOEK = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Windhoek', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** "12 Nov 2026, 09:30 CAT". Always Windhoek time, always labelled. */
export function fmtWindhoek(d: Date | string | null | undefined): string {
  if (!d) return 'Not set';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return 'Not set';
  return `${WINDHOEK.format(date).replace(/^(\d{2}) (\w{3}) (\d{4}),? /, '$1 $2 $3, ')} CAT`;
}

/** A cell that starts with = + - @ (after any whitespace or control characters) is treated as a formula by Excel and Sheets. */
const FORMULA_START = /^[\s\u0000-\u001f]*[=+\-@]/;
export function safeCell(v: string | null | undefined): string {
  const s = v ?? '';
  return FORMULA_START.test(s) ? "'" + s : s;
}

/** A CSV cell that cannot start a spreadsheet formula (leading = + - @ tab CR gets an apostrophe), quoted when it needs to be. */
export const csvCell = (v: string): string => { const s = /^[=+\-@\t\r]/.test(v) ? "'" + v : v; return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };

/** results.csv: the same content for the download and for the audit bundle. */
export function buildCsv(c: CampaignRow, results: ResultsPayload, seal: SealCheck): string {
  const abstain = results.candidates.find((x) => x.is_abstain);
  const q = results.quorum;
  const lines = ['candidate,votes', ...results.candidates.filter((x) => !x.is_abstain).map((x) => `${csvCell(x.withdrawn ? `${x.name} (withdrew: votes void)` : x.name)},${x.votes}`),
    ...(abstain ? [`Abstentions (not a candidate),${abstain.votes}`] : []), `Total ballots,${results.turnout.votes}`,
    ...(q ? [`Quorum,${q.met === false ? `NOT MET: ${q.votes} of ${q.needed} votes needed (${q.percent}% of ${q.eligible})` : q.met ? `met: ${q.votes} of ${q.needed} votes needed (${q.percent}% of ${q.eligible})` : `${q.percent}% (eligible count unknown)`}`] : []),
    ...(results.publication ? [`Published by,${csvCell(results.publication.by ?? 'unknown')} on ${results.publication.at.toISOString()}${results.publication.scheduled ? ' (scheduled)' : ''}`] : []),
    ...(results.tie ? [`Tie,${csvCell('YES: tie for first place between ' + results.tie.names.join(' and '))}`] : []),
    ...(c.runoff_round ? [`Run-off round,${c.runoff_round}`] : []),
    ...(seal.sealed && seal.seal_hash ? [`Sealed at,${new Date(seal.sealed_at!).toISOString()}`, `Seal fingerprint,${seal.seal_hash}`] : [])];
  return lines.join('\r\n') + '\r\n';
}

export const ELIGIBILITY_LABEL: Record<CampaignRow['eligibility'], string> = { all: 'All staff', umoja: 'Umoja members only', list: 'Specific email list' };

export interface ExportData {
  title: string; description: string; status: string;
  opensAt: string; closesAt: string; startedAt: string; closedAt: string;
  eligibility: string; eligibleCount: number | null; turnout: number; turnoutPct: number | null;
  candidates: { rank: number; name: string; votes: number; pct: number }[];
  /** Quorum in words ("" when none was set) and who published the results ("" when not recorded). */
  quorum: string; publication: string;
  /** Candidates who withdrew after voting started: the votes cast for them are void (never a winner, not ranked). */
  withdrawn: { name: string; votes: number }[];
  /** Votes for "Abstain" (null when the campaign had no abstain option). Counted in turnout, never a winner. */
  abstentions: number | null;
  tie: boolean; tiedNames: string[]; leader: string | null;
  /** Run-off context in words ("" when this is an ordinary campaign with no run-off). */
  runoff: string;
  history: { kind: string; at: string; by: string; detail: string }[];
  seal: { sealed: boolean; hash: string | null; sealedAt: string; verified: boolean | null };
  generatedAt: string; generatedBy: string;
}

/** Plain-language line for one post-start edit (mirrors the screen's wording). */
function describeEdit(ch: { what: string; name?: string; from?: string | null; to?: string | null }): string {
  const q = (v: string | null | undefined) => (v ? `"${v}"` : 'empty');
  const t = (v: string | null | undefined) => (v ? fmtWindhoek(v) : 'none');
  switch (ch.what) {
    case 'title': return `title changed from ${q(ch.from)} to ${q(ch.to)}`;
    case 'description': return 'description changed';
    case 'closes_at': return `closing time changed from ${t(ch.from)} to ${t(ch.to)}`;
    case 'candidate_added': return `candidate added: ${ch.name ?? ''}`;
    case 'candidate_removed': return `candidate removed: ${ch.name ?? ''}`;
    default: return ch.from && ch.to ? `candidate renamed from ${ch.from} to ${ch.to}` : `candidate edited: ${ch.name ?? ''}`;
  }
}

export async function gatherExport(db: Queryable, c: CampaignRow, generatedBy: string, now = new Date()): Promise<ExportData> {
  const results = await getResults(db, c.id);
  const seal = await verifySeal(db, c.id);
  const notices = await getNotices(db, c.id, true);
  const times = (await db.query(
    `SELECT (SELECT min(at) FROM audit_log WHERE campaign_id = $1 AND action = 'campaign.start') AS started,
            (SELECT max(at) FROM audit_log WHERE campaign_id = $1 AND action LIKE 'campaign.close%') AS closed`, [c.id])).rows[0];
  const total = results.candidates.reduce((n, x) => n + x.votes, 0);
  const abstain = results.candidates.find((x) => x.is_abstain);
  const withdrawn = results.candidates.filter((x) => x.withdrawn && !x.is_abstain).map((x) => ({ name: x.name, votes: x.votes }));
  const sorted = results.candidates.filter((x) => !x.is_abstain && !x.withdrawn).sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));
  const st = standing(results.candidates);
  const tiedNames = st.tied.map((x) => x.name);
  const tie = tiedNames.length > 1;
  const link = (await db.query(
    `SELECT (SELECT title FROM campaigns WHERE id = $1) AS parent, (SELECT title FROM campaigns WHERE parent_campaign_id = $2 LIMIT 1) AS child`, [c.parent_campaign_id ?? null, c.id])).rows[0];
  const { votes, eligible } = results.turnout;
  const history = notices.map((n) => {
    if (n.kind === 'reset') {
      const before = n.candidates?.length ? `; before the reset: ${n.candidates.map((x) => `${x.name} ${x.votes}`).join(', ')}` : '';
      return { kind: 'Reset', at: fmtWindhoek(n.at), by: n.by ?? '', detail: `${n.votes_cleared ?? 0} vote(s) cleared. Reason: ${n.reason}${before}` };
    }
    if (n.kind === 'candidate_withdrawn') return { kind: 'Candidate withdrew', at: fmtWindhoek(n.at), by: n.by ?? '', detail: `${n.candidate}. Reason: ${n.reason}. Votes already cast for them are void.` };
    if (n.kind === 'closed_early') return { kind: 'Closed early', at: fmtWindhoek(n.at), by: n.by ?? '', detail: `Reason: ${n.reason}` };
    return { kind: 'Edited after start', at: fmtWindhoek(n.at), by: n.by ?? '', detail: (n.changes ?? []).map(describeEdit).join('; ') };
  });
  return {
    title: c.title, description: c.description ?? '', status: c.status,
    opensAt: fmtWindhoek(c.opens_at), closesAt: fmtWindhoek(c.closes_at), startedAt: fmtWindhoek(times.started), closedAt: fmtWindhoek(times.closed),
    eligibility: ELIGIBILITY_LABEL[c.eligibility], eligibleCount: eligible, turnout: votes, turnoutPct: eligible && eligible > 0 ? votes / eligible : null,
    candidates: sorted.map((x, i) => ({ rank: i + 1, name: x.name, votes: x.votes, pct: total > 0 ? x.votes / total : 0 })),
    abstentions: abstain ? abstain.votes : null, withdrawn,
    quorum: results.quorum ? quorumText(results.quorum) : '',
    publication: results.publication ? `Published by ${results.publication.by ?? 'unknown'} on ${fmtWindhoek(results.publication.at)}${results.publication.scheduled ? ' (scheduled; approved by the person who scheduled it)' : ''}` : '',
    tie, tiedNames, leader: st.leader?.name ?? null,
    runoff: [c.runoff_round ? `This is run-off round ${c.runoff_round}${link.parent ? ` of "${link.parent}"` : ''}.` : '', link.child ? `A run-off was started: "${link.child}".` : ''].filter(Boolean).join(' '),
    history,
    seal: {
      sealed: seal.sealed && !!seal.seal_hash, hash: seal.sealed ? seal.seal_hash : null, sealedAt: fmtWindhoek(seal.sealed_at),
      verified: seal.sealed ? seal.chain_ok && seal.tallies_match !== false && seal.receipts_match !== false : null,
    },
    generatedAt: fmtWindhoek(now), generatedBy,
  };
}

/** "NOT MET: 3 of 40 votes needed (10% of 400)" / "met: ..." / "... (eligible count unknown)". */
export const quorumText = (q: NonNullable<ResultsPayload['quorum']>): string =>
  q.met === null ? `${q.percent}% of the eligible voters (the number of eligible voters is not known)`
    : `${q.met ? 'met' : 'NOT MET'}: ${q.votes} of ${q.needed} votes needed (${q.percent}% of ${q.eligible} eligible voters)`;

const pct = (x: number | null) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
const eligibleText = (d: ExportData) => (d.eligibleCount == null ? 'n/a (open to all staff)' : String(d.eligibleCount));
const tieText = (d: ExportData) => (d.tie ? `YES: tie between ${d.tiedNames.join(', ')}` : d.leader ? `No (leader: ${d.leader})` : 'No votes were cast');
const sealText = (d: ExportData) => (d.seal.sealed ? (d.seal.verified ? 'Sealed; counters and receipts match the seal' : 'Sealed; DOES NOT MATCH the seal, investigate') : 'Not sealed');

export async function buildXlsx(d: ExportData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NamRA Voting'; wb.created = new Date();
  const bold = { bold: true };

  const s = wb.addWorksheet('Summary');
  s.columns = [{ width: 28 }, { width: 80 }];
  s.addRow(['NamRA | Voting: campaign results']).font = { bold: true, size: 14 };
  s.addRow([]);
  const rows: [string, string | number][] = [
    ['Campaign', d.title], ['Description', d.description], ['Status', d.status],
    ['Opens (scheduled)', d.opensAt], ['Closes (scheduled)', d.closesAt], ['Started', d.startedAt], ['Closed', d.closedAt],
    ['Who could vote', d.eligibility], ['Eligible voters', d.eligibleCount ?? 'n/a (open to all staff)'],
    ['Turnout (votes cast)', d.turnout], ['Turnout %', d.turnoutPct == null ? 'n/a' : pct(d.turnoutPct)],
    ['Tie', tieText(d)], ...(d.quorum ? [['Quorum', d.quorum] as [string, string]] : []), ...(d.publication ? [['Publication', d.publication] as [string, string]] : []), ...(d.runoff ? [['Run-off', d.runoff] as [string, string]] : []),
    ['Results seal', sealText(d)], ['Seal fingerprint (SHA-256)', d.seal.hash ?? 'n/a'], ['Sealed at', d.seal.sealed ? d.seal.sealedAt : 'n/a'],
    ['Generated at', d.generatedAt], ['Generated by', d.generatedBy],
  ];
  for (const [k, v] of rows) {
    const r = s.addRow([k, typeof v === 'string' ? safeCell(v) : v]);
    r.getCell(1).font = bold; r.getCell(2).alignment = { wrapText: true, vertical: 'top' }; r.getCell(2).numFmt = '@';
    if (typeof v === 'number') r.getCell(2).numFmt = '0';
  }

  const r = wb.addWorksheet('Results');
  r.columns = [{ header: 'Rank', width: 8 }, { header: 'Candidate', width: 40 }, { header: 'Votes', width: 10 }, { header: '% of votes', width: 12 }];
  r.getRow(1).font = bold;
  for (const x of d.candidates) {
    const row = r.addRow([x.rank, safeCell(x.name), x.votes, x.pct]);
    row.getCell(4).numFmt = '0.0%';
  }
  for (const w of d.withdrawn) r.addRow(['', safeCell(`${w.name} (withdrew: votes void)`), w.votes]);
  if (d.abstentions !== null) { const a = r.addRow(['', 'Abstentions (not a candidate)', d.abstentions, d.turnout > 0 ? d.abstentions / d.turnout : 0]); a.getCell(4).numFmt = '0.0%'; }
  r.addRow([]);
  r.addRow(['', 'Total votes', d.turnout]).font = bold;

  const h = wb.addWorksheet('Event history');
  h.columns = [{ header: 'Event', width: 22 }, { header: 'When (Windhoek)', width: 26 }, { header: 'By', width: 28 }, { header: 'Details', width: 90 }];
  h.getRow(1).font = bold;
  if (d.history.length === 0) h.addRow(['None', '', '', 'No resets, early close or edits after start.']);
  for (const e of d.history) {
    const row = h.addRow([e.kind, e.at, safeCell(e.by), safeCell(e.detail)]);
    row.getCell(4).alignment = { wrapText: true, vertical: 'top' };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** The header carries the official NamRA mark (services/logo.ts) and the text "NamRA | Voting". */
export async function buildPdf(d: ExportData, opts: { compress?: boolean } = {}): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 50, compress: opts.compress ?? true, info: { Title: `Results: ${d.title}`.slice(0, 200), Author: 'NamRA Voting', Creator: 'NamRA Voting' } });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => { doc.on('data', (b: Buffer) => chunks.push(b)); doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const L = 50; const W = doc.page.width - 100; const bottom = () => doc.page.height - 60;
  const ensure = (h: number) => { if (doc.y + h > bottom()) doc.addPage(); };

  doc.rect(0, 0, doc.page.width, 56).fill('#14254a');
  // the official mark, as supplied, on a white rounded backing so it shows on the navy bar
  doc.roundedRect(L, 8, 40, 40, 6).fill('#ffffff');
  doc.save(); doc.roundedRect(L + 2, 10, 36, 36, 5).clip(); doc.image(NAMRA_LOGO_JPEG, L + 2, 10, { width: 36, height: 36 }); doc.restore();
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(18).text('NamRA | Voting', L + 52, 19, { width: W - 52 });
  doc.fillColor('#000000').y = 78;

  doc.font('Helvetica-Bold').fontSize(20).text(d.title, L, doc.y, { width: W });
  if (d.description) doc.moveDown(0.3).font('Helvetica').fontSize(10.5).fillColor('#444').text(d.description, { width: W });
  doc.fillColor('#000').moveDown(0.8);

  const kv = (k: string, v: string, mono = false) => {
    ensure(18);
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#333').text(k, L, y, { width: 150 });
    const after = doc.y;
    doc.font(mono ? 'Courier' : 'Helvetica').fontSize(mono ? 8.5 : 10).fillColor('#000').text(v, L + 155, y, { width: W - 155 });
    doc.y = Math.max(after, doc.y) + 3;
  };
  const heading = (t: string) => { ensure(40); doc.moveDown(0.5).font('Helvetica-Bold').fontSize(13).fillColor('#14254a').text(t, L, doc.y, { width: W }); doc.moveDown(0.3).fillColor('#000'); };

  heading('Summary');
  kv('Status', d.status);
  kv('Opens (scheduled)', d.opensAt); kv('Closes (scheduled)', d.closesAt); kv('Started', d.startedAt); kv('Closed', d.closedAt);
  kv('Who could vote', d.eligibility); kv('Eligible voters', eligibleText(d));
  kv('Turnout', `${d.turnout} vote(s), ${pct(d.turnoutPct)} of eligible voters`);
  kv('Tie', tieText(d));
  if (d.runoff) kv('Run-off', d.runoff);
  if (d.quorum) kv('Quorum', d.quorum);
  if (d.publication) kv('Publication', d.publication);

  heading('Results');
  const cx = [L, L + 40, L + W - 150, L + W - 70];
  ensure(24);
  const hy = doc.y;
  doc.font('Helvetica-Bold').fontSize(9.5);
  doc.text('Rank', cx[0], hy, { width: 36 }); doc.text('Candidate', cx[1], hy, { width: cx[2] - cx[1] - 10 });
  doc.text('Votes', cx[2], hy, { width: 60, align: 'right' }); doc.text('% of votes', cx[3], hy, { width: 70, align: 'right' });
  doc.y = hy + 16; doc.moveTo(L, doc.y - 3).lineTo(L + W, doc.y - 3).strokeColor('#999').lineWidth(0.5).stroke();
  for (const x of d.candidates) {
    ensure(20);
    const y = doc.y;
    doc.font('Helvetica').fontSize(10).fillColor('#000');
    doc.text(String(x.rank), cx[0], y, { width: 36 });
    doc.text(x.name, cx[1], y, { width: cx[2] - cx[1] - 10 });
    const rowEnd = doc.y;
    doc.text(String(x.votes), cx[2], y, { width: 60, align: 'right' }); doc.text(pct(x.pct), cx[3], y, { width: 70, align: 'right' });
    doc.y = rowEnd + 4;
  }
  for (const w of d.withdrawn) {
    ensure(20);
    const y = doc.y;
    doc.font('Helvetica-Oblique').fontSize(10).fillColor('#444').text(`${w.name} (withdrew: votes void)`, cx[1], y, { width: cx[2] - cx[1] - 10 });
    doc.text(String(w.votes), cx[2], y, { width: 60, align: 'right' }); doc.fillColor('#000');
    doc.y += 4;
  }
  if (d.abstentions !== null) {
    ensure(20);
    const y = doc.y;
    doc.font('Helvetica-Oblique').fontSize(10).fillColor('#444').text('Abstentions (not a candidate)', cx[1], y, { width: cx[2] - cx[1] - 10 });
    doc.text(String(d.abstentions), cx[2], y, { width: 60, align: 'right' }); doc.fillColor('#000');
    doc.y += 4;
  }
  ensure(20);
  doc.font('Helvetica-Bold').fontSize(10).text('Total votes', cx[1], doc.y, { continued: false, width: 200 });
  doc.text(String(d.turnout), cx[2], doc.y - 12, { width: 60, align: 'right' });
  doc.y += 6;

  heading('History: resets, early close and edits after start');
  if (d.history.length === 0) { doc.font('Helvetica').fontSize(10).text('None.', L, doc.y, { width: W }); }
  for (const e of d.history) {
    ensure(36);
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000').text(`${e.kind}: ${e.at}${e.by ? `, by ${e.by}` : ''}`, L, doc.y, { width: W });
    doc.font('Helvetica').fontSize(9.5).fillColor('#333').text(e.detail, L + 10, doc.y, { width: W - 10 });
    doc.fillColor('#000').moveDown(0.4);
  }

  heading('Integrity seal');
  kv('Seal', sealText(d));
  if (d.seal.sealed) { kv('Sealed at', d.seal.sealedAt); kv('Fingerprint (SHA-256)', d.seal.hash ?? '', true); }

  doc.moveDown(1);
  ensure(30);
  doc.font('Helvetica').fontSize(8.5).fillColor('#666').text(`Generated ${d.generatedAt} by ${d.generatedBy}. All times are Windhoek time (CAT).`, L, doc.y, { width: W });
  doc.end();
  return done;
}
