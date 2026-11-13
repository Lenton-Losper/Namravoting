// Results, seals and exports with several positions: per-position winners, ties, turnout, seal fingerprints, CSV / Excel / PDF / audit bundle.
import ExcelJS from 'exceljs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool, getPool } from '../../src/db.js';
import { unzipStored } from '../../src/services/zip.js';
import { buildPdf, gatherExport } from '../../src/services/resultsExport.js';
import { ADMIN_A, ADMIN_B, S1, S2, S3, S4, S5, closeOwner, login, makeElection, ownerDb, resetDb, type Election } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

type Sess = Awaited<ReturnType<typeof login>>;
const bin = (res: import('superagent').Response, cb: (e: Error | null, b: Buffer) => void) => { const k: Buffer[] = []; res.on('data', (d: Buffer) => k.push(d)); res.on('end', () => cb(null, Buffer.concat(k))); };
const download = async (s: Sess, url: string) => (await s.get(url).buffer(true).parse(bin).expect(200)).body as Buffer;
/** Text shown by an UNcompressed pdfkit document: its strings are hex-encoded in the TJ operators. */
const pdfText = (buf: Buffer) => [...buf.toString('latin1').matchAll(/\[([^\]]*)\]\s*TJ/g)]
  .map((m) => [...m[1].matchAll(/<([0-9a-f]*)>/g)].map((h) => Buffer.from(h[1], 'hex').toString('latin1')).join('')).join('\n');
const voteIn = (s: Sess, e: Election, p: number, c: number) => s.post(`/api/vote/${e.token}/positions/${e.positions[p].id}`).send({ candidateId: e.positions[p].candidates[c].id });

/**
 * Press Secretary: Alice 2, Bob 2, Chipo 0 (a TIE).  Finance Officer: Dana 1, Esau 1 (a TIE).  Treasurer: nobody votes.
 * Four members vote in Press Secretary, two in Finance Officer: turnout 4 overall.
 */
async function closedElection(opts: { group?: boolean; abstain?: boolean } = {}) {
  const admin = await login(app, ADMIN_A);
  const e = await makeElection(admin, {
    abstain: opts.abstain, start: true,
    positions: [
      { title: 'Press Secretary', candidates: [{ name: 'Alice', region: 'Khomas' }, { name: 'Bob', region: 'Erongo' }, { name: 'Chipo', region: 'Zambezi' }] },
      { title: 'Finance Officer', candidates: [{ name: 'Dana', region: 'Oshana' }, { name: 'Esau', region: 'Khomas' }] },
      { title: 'Treasurer', candidates: [{ name: 'Fiona', region: 'Hardap' }, { name: 'Gideon' }] },
    ],
  });
  if (opts.group) await admin.put(`/api/campaigns/${e.id}/results-view`).send({ group_by_region: true }).expect(200);
  const [s1, s2, s3, s4] = await Promise.all([S1, S2, S3, S4].map((u) => login(app, u)));
  await voteIn(s1, e, 0, 0).expect(201); await voteIn(s2, e, 0, 0).expect(201); await voteIn(s3, e, 0, 1).expect(201); await voteIn(s4, e, 0, 1).expect(201);
  await voteIn(s1, e, 1, 0).expect(201); await voteIn(s2, e, 1, 1).expect(201);
  await admin.post(`/api/campaigns/${e.id}/close`).send({ reason: 'Closing for the test run' }).expect(200);
  return { admin, e };
}
const sealDetails = async (id: string) => (await ownerDb().query("SELECT seq, hash, details FROM audit_log WHERE campaign_id = $1 AND action LIKE 'campaign.close%' ORDER BY seq DESC LIMIT 1", [id])).rows[0];

describe('results per position', () => {
  it('gives each position its own tallies, turnout, winner and tie, and the campaign its turnout of members who voted at least once', async () => {
    const { admin, e } = await closedElection();
    const r = (await admin.get(`/api/campaigns/${e.id}/results`).expect(200)).body;
    expect(r.turnout.votes).toBe(4);
    expect(r.tie).toBeNull();                                                                       // several positions: no single campaign-wide tie
    const [press, fin, tre] = r.positions;
    expect(press).toMatchObject({ title: 'Press Secretary', turnout: { votes: 4 }, winners: [], tie: { names: ['Alice', 'Bob'], votes: 2 } });
    expect(press.candidates.map((c: { name: string; votes: number }) => [c.name, c.votes])).toEqual([['Alice', 2], ['Bob', 2], ['Chipo', 0]]);
    expect(fin).toMatchObject({ title: 'Finance Officer', turnout: { votes: 2 }, tie: { names: ['Dana', 'Esau'], votes: 1 } });
    expect(tre).toMatchObject({ title: 'Treasurer', turnout: { votes: 0 }, winners: [], tie: null });
    expect(r.candidates).toHaveLength(7);
    expect(r.candidates.every((c: { position_id: string }) => e.positions.some((p) => p.id === c.position_id))).toBe(true);
    // the block on the admin page shows turnout and the winner (here: ties) once closed
    const blocks = (await admin.get(`/api/campaigns/${e.id}/positions`).expect(200)).body.positions;
    expect(blocks.map((b: { result: { turnout: number; winners: string[]; tie: string[] | null } }) => [b.result.turnout, b.result.winners, b.result.tie])).toEqual([[4, [], ['Alice', 'Bob']], [2, [], ['Dana', 'Esau']], [0, [], null]]);
  });

  it('names a winner where there is one, per position, and the dashboard shows no single winner for a multi-position campaign', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'P1', candidates: ['A', 'B'] }, { title: 'P2', candidates: ['C', 'D'] }], start: true });
    const [s1, s2] = await Promise.all([S1, S2].map((u) => login(app, u)));
    await voteIn(s1, e, 0, 1).expect(201); await voteIn(s2, e, 0, 1).expect(201); await voteIn(s1, e, 1, 0).expect(201);
    await admin.post(`/api/campaigns/${e.id}/close`).send({ reason: 'Closing for the test run' }).expect(200);
    const r = (await admin.get(`/api/campaigns/${e.id}/results`).expect(200)).body;
    expect(r.positions.map((p: { winners: { name: string; votes: number }[] }) => p.winners.map((w) => [w.name, w.votes]))).toEqual([[['B', 2]], [['C', 1]]]);
    const sum = (await admin.get('/api/campaigns/summary').expect(200)).body;
    expect(sum.closed[0].winner).toBeNull();
  });

  it('voters see per-position results once published, with the same shape', async () => {
    const { admin, e } = await closedElection();
    await admin.post(`/api/campaigns/${e.id}/publish`).expect(200);
    const r = (await (await login(app, S1)).get(`/api/vote/${e.token}/results`).expect(200)).body;
    expect(r.positions.map((p: { title: string }) => p.title)).toEqual(['Press Secretary', 'Finance Officer', 'Treasurer']);
    expect(r.positions[0].candidates.map((c: { region: string }) => c.region)).toEqual(['Khomas', 'Erongo', 'Zambezi']);
  });

  it('the admin can choose to group results by region, at any time, and it is recorded', async () => {
    const { admin, e } = await closedElection();
    expect((await admin.get(`/api/campaigns/${e.id}/results`).expect(200)).body.group_by_region).toBe(false);
    await admin.put(`/api/campaigns/${e.id}/results-view`).send({ group_by_region: true }).expect(200);
    expect((await admin.get(`/api/campaigns/${e.id}/results`).expect(200)).body.group_by_region).toBe(true);
    await admin.put(`/api/campaigns/${e.id}/results-view`).send({ group_by_region: 'yes' }).expect(400);
    expect((await ownerDb().query("SELECT count(*)::int AS n FROM audit_log WHERE campaign_id = $1 AND action = 'results.view_changed'", [e.id])).rows[0].n).toBe(1);
  });

  it('a run-off is not offered for a campaign with several positions (ties are per position)', async () => {
    const { admin, e } = await closedElection();
    const r = await admin.post(`/api/campaigns/${e.id}/runoff`).expect(409);
    expect(r.body.code).toMatch(/no_tie|runoff_multi_position/);
  });
});

describe('a seal per position', () => {
  it('the close entry seals every position with its own fingerprint, turnout and counters, and verification passes', async () => {
    const { admin, e } = await closedElection();
    const seal = await sealDetails(e.id);
    expect(seal.details.positions.map((p: { title: string; receipts: number; ballots: number }) => [p.title, p.receipts, p.ballots])).toEqual([['Press Secretary', 4, 4], ['Finance Officer', 2, 2], ['Treasurer', 0, 0]]);
    const prints = seal.details.positions.map((p: { fingerprint: string }) => p.fingerprint);
    expect(new Set(prints).size).toBe(3);
    for (const f of prints) expect(f).toMatch(/^[0-9a-f]{64}$/);
    expect(seal.details.tallies.every((t: { position_id: string; position: string }) => t.position_id && t.position)).toBe(true);
    const v = (await admin.get(`/api/campaigns/${e.id}/verify`).expect(200)).body;
    expect(v).toMatchObject({ chain_ok: true, sealed: true, tallies_match: true, receipts_match: true, seal_hash: seal.hash });
    expect(v.positions.map((p: { title: string; tallies_match: boolean; receipts_match: boolean }) => [p.title, p.tallies_match, p.receipts_match])).toEqual([['Press Secretary', true, true], ['Finance Officer', true, true], ['Treasurer', true, true]]);
    expect(v.positions.map((p: { fingerprint: string }) => p.fingerprint)).toEqual(prints);
  });

  it('a changed counter breaks ONLY its own position\'s seal, and the overall check fails', async () => {
    const { admin, e } = await closedElection();
    await ownerDb().query('UPDATE tallies SET votes = votes + 1 WHERE candidate_id = $1', [e.positions[1].candidates[0].id]);   // Finance Officer: Dana
    const v = (await admin.get(`/api/campaigns/${e.id}/verify`).expect(200)).body;
    expect(v.tallies_match).toBe(false);
    expect(v.positions.map((p: { title: string; tallies_match: boolean }) => [p.title, p.tallies_match])).toEqual([['Press Secretary', true], ['Finance Officer', false], ['Treasurer', true]]);
    // a result that no longer matches its seal is not published
    expect((await admin.post(`/api/campaigns/${e.id}/publish`).expect(409)).body.code).toBe('integrity_failed');
  });

  it('a missing receipt breaks only its own position\'s receipts check', async () => {
    const { admin, e } = await closedElection();
    await ownerDb().query('DELETE FROM vote_receipts WHERE position_id = $1 AND voter_oid = $2', [e.positions[0].id, S1.oid]);
    const v = (await admin.get(`/api/campaigns/${e.id}/verify`).expect(200)).body;
    expect(v.receipts_match).toBe(false);
    expect(v.positions.map((p: { title: string; receipts_match: boolean }) => [p.title, p.receipts_match])).toEqual([['Press Secretary', false], ['Finance Officer', true], ['Treasurer', true]]);
  });

  it('closing is blocked when ONE position\'s receipts and counters disagree, even if the totals still agree', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'P1', candidates: ['A', 'B'] }, { title: 'P2', candidates: ['C', 'D'] }], start: true });
    await voteIn(await login(app, S1), e, 0, 0).expect(201);
    await voteIn(await login(app, S2), e, 1, 0).expect(201);
    // move one count from P1 to P2: the totals (2 = 2) are fine, the positions are not
    await ownerDb().query('UPDATE tallies SET votes = votes - 1 WHERE candidate_id = $1', [e.positions[0].candidates[0].id]);
    await ownerDb().query('UPDATE tallies SET votes = votes + 1 WHERE candidate_id = $1', [e.positions[1].candidates[1].id]);
    const r = await admin.post(`/api/campaigns/${e.id}/close`).send({ reason: 'Closing for the test run' }).expect(409);
    expect(r.body.code).toBe('integrity_mismatch');
    expect(r.body.error).toContain('P1');
    expect((await ownerDb().query('SELECT status FROM campaigns WHERE id = $1', [e.id])).rows[0].status).toBe('open');
  });

  it('an observer cannot see per-position counts or fingerprints of a round that was later reset', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'P1', candidates: ['A', 'B'] }, { title: 'P2', candidates: ['C', 'D'] }], start: true });
    await login(app, S5);                                                                          // the observer must have signed in once
    await admin.post(`/api/campaigns/${e.id}/team`).send({ email: S5.email, role: 'observer' }).expect(201);
    await voteIn(await login(app, S1), e, 0, 0).expect(201);
    await admin.post(`/api/campaigns/${e.id}/close`).send({ reason: 'Closing for the test run' }).expect(200);
    await admin.post(`/api/campaigns/${e.id}/reset`).send({ confirm_title: 'Umoja Committee 2026', reason: 'The wrong list was shown to voters' }).expect(200);
    const watch = (await (await login(app, S5)).get(`/api/observe/${e.id}`).expect(200)).body;
    expect(watch.status).toBe('open');
    const close = watch.audit.find((a: { action: string }) => a.action === 'campaign.close');
    expect(close.details.tallies).toBeUndefined();
    expect(close.details.positions).toBeUndefined();
    expect(JSON.stringify(watch.audit.filter((a: { action: string }) => /^campaign\.(close|reset)/.test(a.action)))).not.toMatch(/fingerprint|"votes":\s*[2-9]/);
  });
});

describe('exports with several positions', () => {
  it('the CSV lists every candidate with position and region, each position\'s turnout and outcome, and each position\'s seal fingerprint', async () => {
    const { admin, e } = await closedElection({ abstain: false });
    const csv = (await admin.get(`/api/campaigns/${e.id}/results.csv`).expect(200)).text;
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('position,candidate,region,votes');
    expect(lines).toContain('Press Secretary,Alice,Khomas,2');
    expect(lines).toContain('Press Secretary,Chipo,Zambezi,0');
    expect(lines).toContain('Finance Officer,Dana,Oshana,1');
    expect(lines).toContain('Treasurer,Gideon,,0');
    expect(lines).toContain('Press Secretary,Members who voted in this position,,4');
    expect(lines).toContain('Treasurer,Members who voted in this position,,0');
    expect(lines).toContain('Press Secretary,Tie for first place: Alice and Bob,,');
    expect(lines).toContain('Treasurer,No winner (no votes),,');
    expect(lines).toContain('Members who voted in at least one position,4');
    const seal = await sealDetails(e.id);
    for (const p of seal.details.positions) expect(lines).toContain(`${p.title},Position seal fingerprint,,${p.fingerprint}`);
    expect(lines).toContain(`Seal fingerprint,${seal.hash}`);
    expect((await ownerDb().query("SELECT count(*)::int AS n FROM audit_log WHERE campaign_id = $1 AND action = 'results.export_csv'", [e.id])).rows[0].n).toBe(1);
  });

  it('groups the rows by region when the admin chose that, and reports abstentions per position', async () => {
    const { admin, e } = await closedElection({ group: true, abstain: true });
    const lines = (await admin.get(`/api/campaigns/${e.id}/results.csv`).expect(200)).text.split('\r\n');
    const press = lines.filter((l) => l.startsWith('Press Secretary,') && /,(Erongo|Khomas|Zambezi),/.test(l));
    expect(press.map((l) => l.split(',')[2])).toEqual(['Erongo', 'Khomas', 'Zambezi']);                  // by region, not by ballot order
    expect(lines.filter((l) => l.includes('Abstentions (not a candidate)'))).toHaveLength(3);
    expect(lines).toContain('Results grouped by region,yes');
  });

  it('the Excel workbook has a Position column and a row group per position, and a seal row per position', async () => {
    const { admin, e } = await closedElection();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await download(admin, `/api/campaigns/${e.id}/results.xlsx`) as unknown as ArrayBuffer);
    const res = wb.getWorksheet('Results')!;
    expect(res.getRow(1).values).toEqual([undefined, 'Position', 'Rank', 'Candidate', 'Region', 'Votes', '% of votes']);
    const rows: unknown[][] = [];
    res.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
    expect(rows.some((r) => r[0] === 'Press Secretary' && r[2] === 'Alice' && r[3] === 'Khomas' && r[4] === 2)).toBe(true);
    expect(rows.some((r) => r[0] === 'Finance Officer' && r[2] === 'Members who voted in this position' && r[4] === 2)).toBe(true);
    const summary: string[] = [];
    wb.getWorksheet('Summary')!.eachRow((row) => summary.push(String(row.values && (row.values as unknown[])[1])));
    for (const t of ['Press Secretary', 'Finance Officer', 'Treasurer']) expect(summary).toContain(`Position seal: ${t}`);
  });

  it('the PDF names every position with its turnout, outcome and seal fingerprint', async () => {
    const { e } = await closedElection({ group: true });
    const row = (await ownerDb().query('SELECT * FROM campaigns WHERE id = $1', [e.id])).rows[0];
    const data = await gatherExport(getPool(), row, 'Tester');
    expect(data.multi).toBe(true);
    expect(data.groupByRegion).toBe(true);
    expect(data.positions.map((p) => p.title)).toEqual(['Press Secretary', 'Finance Officer', 'Treasurer']);
    expect(data.positions[0].tiedNames).toEqual(['Alice', 'Bob']);
    const text = pdfText(await buildPdf(data, { compress: false }));
    for (const p of data.positions) {
      expect(text).toContain(p.title);
      expect(text).toContain(p.fingerprint!);
    }
    expect(text).toContain('Tie for first place: Alice and Bob');
    expect(text).toContain('Members who voted in at least one position: 4');
    expect(text).toContain('Khomas');                                                                // region sub-headings when grouped
    // the real download is a PDF and is audited
    const admin = await login(app, ADMIN_A);
    const pdf = await download(admin, `/api/campaigns/${e.id}/results.pdf`);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('the audit bundle contains the per-position results and states each position\'s seal in its README', async () => {
    const { admin, e } = await closedElection();
    const f = Object.fromEntries(unzipStored(await download(admin, `/api/campaigns/${e.id}/audit-bundle.zip`)).map((x) => [x.name, x.data]));
    const readme = f['README.txt'].toString();
    const seal = await sealDetails(e.id);
    expect(readme).toContain('Positions:                            3');
    for (const p of seal.details.positions) expect(readme).toContain(`- ${p.title}: ${p.receipts} voted; fingerprint ${p.fingerprint}`);
    expect(f['results.csv'].toString()).toBe((await admin.get(`/api/campaigns/${e.id}/results.csv`).expect(200)).text);
    expect(f['audit-log.csv'].toString()).toContain('position.');
  });

  it('only the campaign\'s own administrators can export (the wrong admin gets 404)', async () => {
    const { e } = await closedElection();
    const other = await login(app, ADMIN_B);
    for (const f of ['results.csv', 'results.xlsx', 'results.pdf', 'audit-bundle.zip', 'results', 'verify']) await other.get(`/api/campaigns/${e.id}/${f}`).expect(404);
  });
});
