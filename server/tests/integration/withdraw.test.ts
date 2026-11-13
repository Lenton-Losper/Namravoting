// Business-logic item 4: a candidate withdraws after voting has started. Their votes are void; nobody can pick them any more.
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { ADMIN_A, ADMIN_B, S1, S2, S3, S4, TEST_APP_URL, closeOwner, login, ownerDb, resetDb } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); await appRole.end(); });
const appRole = new pg.Pool({ connectionString: TEST_APP_URL, max: 1 });

type Admin = Awaited<ReturnType<typeof login>>;
async function make(admin: Admin, n = 3, opts: { start?: boolean; abstain?: boolean } = {}) {
  const c = (await admin.post('/api/campaigns').send({ title: 'Withdraw test', eligibility: 'all', ...(opts.abstain ? { allow_abstain: true } : {}) }).expect(201)).body;
  const cands: string[] = [];
  for (let i = 0; i < n; i++) cands.push((await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', `Cand ${i + 1}`).expect(201)).body.id);
  if (opts.start !== false) await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
  return { id: c.id as string, token: c.share_token as string, cands };
}
const vote = async (token: string, who: typeof S1, cand: string, status = 201) => (await login(app, who)).post(`/api/vote/${token}`).send({ candidateId: cand }).expect(status);
const reason = { reason: 'Withdrew for personal reasons' };

describe('withdrawing', () => {
  it('needs an open campaign, a reason, a real candidate, and at least 2 left in the running', async () => {
    const admin = await login(app, ADMIN_A);
    const d = await make(admin, 3, { start: false });
    expect((await admin.post(`/api/campaigns/${d.id}/candidates/${d.cands[0]}/withdraw`).send(reason).expect(409)).body.code).toBe('not_started');
    const c = await make(admin, 3, { abstain: true });
    await admin.post(`/api/campaigns/${c.id}/candidates/${c.cands[0]}/withdraw`).send({ reason: 'short' }).expect(400);
    await admin.post(`/api/campaigns/${c.id}/candidates/${c.cands[0]}/withdraw`).send({}).expect(400);
    const abs = (await ownerDb().query('SELECT id FROM candidates WHERE campaign_id = $1 AND is_abstain', [c.id])).rows[0].id;
    await admin.post(`/api/campaigns/${c.id}/candidates/${abs}/withdraw`).send(reason).expect(404);                 // Abstain is not a candidate
    await admin.post(`/api/campaigns/${c.id}/candidates/${c.cands[0]}/withdraw`).send(reason).expect(200);
    expect((await admin.post(`/api/campaigns/${c.id}/candidates/${c.cands[0]}/withdraw`).send(reason).expect(409)).body.code).toBe('already_withdrawn');
    expect((await admin.post(`/api/campaigns/${c.id}/candidates/${c.cands[1]}/withdraw`).send(reason).expect(409)).body.code).toBe('needs_candidates');
    await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
    expect((await admin.post(`/api/campaigns/${c.id}/candidates/${c.cands[2]}/withdraw`).send(reason).expect(409)).body.code).toBe('closed');
  });

  it('only the campaign\'s creator or a co-admin; everyone else gets 404 or 403', async () => {
    const admin = await login(app, ADMIN_A); const other = await login(app, ADMIN_B); const staff = await login(app, S1);
    const c = await make(admin);
    await other.post(`/api/campaigns/${c.id}/candidates/${c.cands[0]}/withdraw`).send(reason).expect(404);
    await staff.post(`/api/campaigns/${c.id}/candidates/${c.cands[0]}/withdraw`).send(reason).expect(403);
    await admin.post(`/api/campaigns/${c.id}/team`).send({ email: ADMIN_B.email, role: 'co_admin' }).expect(201);
    await other.post(`/api/campaigns/${c.id}/candidates/${c.cands[0]}/withdraw`).send(reason).expect(200);
  });

  it('is audited with the reason, and voters see it on the ballot', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin);
    await admin.post(`/api/campaigns/${c.id}/candidates/${c.cands[1]}/withdraw`).send(reason).expect(200);
    const a = (await ownerDb().query("SELECT details, actor_oid FROM audit_log WHERE campaign_id = $1 AND action = 'candidate.withdrawn'", [c.id])).rows;
    expect(a).toHaveLength(1);
    expect(a[0].details).toMatchObject({ name: 'Cand 2', reason: reason.reason });
    expect(a[0].actor_oid).toBe(ADMIN_A.oid);
    expect(JSON.stringify(a[0].details)).not.toMatch(/votes/);                                        // no live counts are recorded
    const ballot = (await (await login(app, S1)).get(`/api/vote/${c.token}`).expect(200)).body;
    expect(ballot.candidates.map((x: { name: string; withdrawn: boolean }) => [x.name, x.withdrawn])).toEqual([['Cand 1', false], ['Cand 2', true], ['Cand 3', false]]);
    expect(ballot.notices).toEqual([expect.objectContaining({ kind: 'candidate_withdrawn', candidate: 'Cand 2', reason: reason.reason })]);
  });
});

describe('after a withdrawal', () => {
  it('nobody can vote for the withdrawn candidate, and a refused vote leaves no receipt', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin);
    await admin.post(`/api/campaigns/${c.id}/candidates/${c.cands[0]}/withdraw`).send(reason).expect(200);
    const r = await vote(c.token, S1, c.cands[0], 409);
    expect(r.body.code).toBe('candidate_withdrawn');
    expect((await ownerDb().query('SELECT count(*)::int AS n FROM vote_receipts WHERE campaign_id = $1', [c.id])).rows[0].n).toBe(0);
    await vote(c.token, S1, c.cands[1], 201);                                          // the same person can still vote for someone else
  });

  it('votes already cast for them are void: counted in turnout and the seal, never a winner, reported separately', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin);
    for (const who of [S1, S2, S3]) await vote(c.token, who, c.cands[0], 201);        // 3 votes for Cand 1
    await vote(c.token, S4, c.cands[1], 201);                                          // 1 for Cand 2
    await admin.post(`/api/campaigns/${c.id}/candidates/${c.cands[0]}/withdraw`).send(reason).expect(200);
    await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
    const r = (await admin.get(`/api/campaigns/${c.id}/results`).expect(200)).body;
    expect(r.turnout.votes).toBe(4);
    expect(r.candidates.find((x: { name: string }) => x.name === 'Cand 1')).toMatchObject({ votes: 3, withdrawn: true });
    expect(r.tie).toBeNull();
    expect((await admin.get('/api/campaigns/summary').expect(200)).body.closed[0].winner.name).toBe('Cand 2');   // not the withdrawn leader
    expect((await admin.get(`/api/campaigns/${c.id}/verify`).expect(200)).body).toMatchObject({ chain_ok: true, sealed: true, tallies_match: true, receipts_match: true });
  });

  it('a tie is judged without the withdrawn candidate', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, 3);
    for (const who of [S1, S2, S3]) await vote(c.token, who, c.cands[0], 201);
    await vote(c.token, S4, c.cands[1], 201);
    await admin.post(`/api/campaigns/${c.id}/candidates/${c.cands[0]}/withdraw`).send(reason).expect(200);
    await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
    expect((await admin.get(`/api/campaigns/${c.id}/results`)).body.tie).toBeNull();                  // Cand 2 (1) leads Cand 3 (0)
  });

  it('the CSV, and the Excel and PDF, mark the votes as void and do not rank them', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin);
    await vote(c.token, S1, c.cands[0], 201); await vote(c.token, S2, c.cands[1], 201);
    await admin.post(`/api/campaigns/${c.id}/candidates/${c.cands[0]}/withdraw`).send(reason).expect(200);
    await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
    const csv = (await admin.get(`/api/campaigns/${c.id}/results.csv`).expect(200)).text;
    expect(csv).toContain('Cand 1 (withdrew: votes void),1');
    const x = await admin.get(`/api/campaigns/${c.id}/results.xlsx`).buffer(true).parse((res, cb) => { const k: Buffer[] = []; res.on('data', (d: Buffer) => k.push(d)); res.on('end', () => cb(null, Buffer.concat(k))); }).expect(200);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.body as never);
    const rows: string[] = []; wb.getWorksheet('Results')!.eachRow((row) => rows.push((row.values as unknown[]).slice(1).join('|')));
    expect(rows.some((l) => l.startsWith('|Cand 1 (withdrew: votes void)|1'))).toBe(true);
    expect(rows.filter((l) => /^\d+\|Cand 1/.test(l))).toHaveLength(0);
    const hist = wb.getWorksheet('Event history')!; const h: string[] = []; hist.eachRow((row) => h.push(String(row.getCell(1).value)));
    expect(h).toContain('Candidate withdrew');
    await admin.get(`/api/campaigns/${c.id}/results.pdf`).expect(200);
  });

  it('a reset keeps the candidate withdrawn, and everyone can vote again', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin);
    await vote(c.token, S1, c.cands[0], 201);
    await admin.post(`/api/campaigns/${c.id}/candidates/${c.cands[0]}/withdraw`).send(reason).expect(200);
    await admin.post(`/api/campaigns/${c.id}/reset`).send({ confirm_title: 'Withdraw test', reason: 'Start again without them' }).expect(200);
    await vote(c.token, S1, c.cands[1], 201);
    expect((await vote(c.token, S2, c.cands[0], 409)).body.code).toBe('candidate_withdrawn');
  });
});

describe('the database', () => {
  it('only allows marking a candidate withdrawn while open; it refuses edits, deletes and undoing a withdrawal', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin);
    await expect(appRole.query("UPDATE candidates SET name = 'Renamed' WHERE id = $1", [c.cands[0]])).rejects.toThrow(/locked/);
    await expect(appRole.query('DELETE FROM candidates WHERE id = $1', [c.cands[0]])).rejects.toThrow(/locked/);
    await expect(appRole.query("UPDATE candidates SET name = 'Renamed', withdrawn_at = now(), withdrawn_reason = 'a reason' WHERE id = $1", [c.cands[0]])).rejects.toThrow(/locked/);   // marking AND editing is not allowed
    await admin.post(`/api/campaigns/${c.id}/candidates/${c.cands[0]}/withdraw`).send(reason).expect(200);
    await expect(appRole.query('UPDATE candidates SET withdrawn_at = NULL, withdrawn_reason = NULL WHERE id = $1', [c.cands[0]])).rejects.toThrow(/locked/);
    await expect(appRole.query("UPDATE candidates SET withdrawn_at = now() WHERE id = $1", [c.cands[1]])).rejects.toThrow(/withdrawn_consistent/);   // a reason is required
  });
});
