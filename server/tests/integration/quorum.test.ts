// Business-logic item 8: an optional quorum; and "Announce winners" (which replaced publishing: voters never see results).
import ExcelJS from 'exceljs';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { quorumOf } from '../../src/services/campaigns.js';
import { ADMIN_A, ADMIN_B, S1, S2, S3, S4, TEST_APP_URL, closeOwner, login, makeElection, ownerDb, resetDb } from '../helpers.js';
import { pgc } from '../testDb.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); await appRole.end(); });
const appRole = new pg.Pool({ ...pgc(TEST_APP_URL), max: 1 });

type Admin = Awaited<ReturnType<typeof login>>;
const VOTERS = [S1, S2, S3, S4];

/** A listed vote for S1..S4 with the given quorum; `votes` of them vote; optionally closed. */
async function vote(admin: Admin, opts: { quorum?: number | null; votes: number; close?: boolean }) {
  const c = (await admin.post('/api/campaigns').send({ title: 'Quorum vote', eligibility: 'list', emails: VOTERS.map((v) => v.email), ...(opts.quorum ? { quorum_percent: opts.quorum } : {}) }).expect(201)).body;
  const cands: string[] = [];
  for (const n of ['One', 'Two']) cands.push((await admin.post(`/api/campaigns/${c.id}/candidates`).field('region', 'Khomas').field('name', n).expect(201)).body.id);
  await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
  for (let i = 0; i < opts.votes; i++) await (await login(app, VOTERS[i])).post(`/api/vote/${c.share_token}`).send({ candidateId: cands[0] }).expect(201);
  if (opts.close !== false) await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
  return { id: c.id as string, token: c.share_token as string };
}
const row = async (id: string) => (await ownerDb().query('SELECT winners_announced_at, winners_announced_by, winners_announcement FROM campaigns WHERE id = $1', [id])).rows[0];

describe('quorumOf (pure)', () => {
  it('needs ceil(eligible x percent), is unknown without an eligible count, and is null when none is set', () => {
    expect(quorumOf(50, { votes: 3, eligible: 7 })).toEqual({ percent: 50, eligible: 7, needed: 4, votes: 3, met: false });
    expect(quorumOf(50, { votes: 4, eligible: 7 })).toMatchObject({ needed: 4, met: true });
    expect(quorumOf(30, { votes: 5, eligible: null })).toMatchObject({ needed: null, met: null });
    expect(quorumOf(null, { votes: 1, eligible: 5 })).toBeNull(); expect(quorumOf(0, { votes: 1, eligible: 5 })).toBeNull();
  });
});

describe('the quorum setting', () => {
  it('is set on a draft, needs a known voter list, can be changed or cleared while a draft, and is locked at start', async () => {
    const admin = await login(app, ADMIN_A);
    await admin.post('/api/campaigns').send({ title: 'x', eligibility: 'all', quorum_percent: 50 }).expect(400);
    await admin.post('/api/campaigns').send({ title: 'x', eligibility: 'list', emails: [S1.email], quorum_percent: 0 }).expect(400);
    await admin.post('/api/campaigns').send({ title: 'x', eligibility: 'list', emails: [S1.email], quorum_percent: 101 }).expect(400);
    const c = (await admin.post('/api/campaigns').send({ title: 'x', eligibility: 'list', emails: [S1.email], quorum_percent: 40, allow_edits_after_start: true }).expect(201)).body;
    expect(c.quorum_percent).toBe(40);
    expect((await admin.patch(`/api/campaigns/${c.id}`).send({ quorum_percent: 60 }).expect(200)).body.quorum_percent).toBe(60);
    await admin.put(`/api/campaigns/${c.id}/eligible`).send({ mode: 'all' }).expect(409);              // would leave a quorum with nobody to count against
    expect((await admin.patch(`/api/campaigns/${c.id}`).send({ quorum_percent: null }).expect(200)).body.quorum_percent).toBeNull();
    await admin.patch(`/api/campaigns/${c.id}`).send({ quorum_percent: 60 }).expect(200);
    for (const n of ['One', 'Two']) await admin.post(`/api/campaigns/${c.id}/candidates`).field('region', 'Khomas').field('name', n).expect(201);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    expect((await admin.patch(`/api/campaigns/${c.id}`).send({ quorum_percent: 10 }).expect(409)).body.code).toBe('locked');   // even with "edits after start"
    await expect(appRole.query('UPDATE campaigns SET quorum_percent = 10 WHERE id = $1', [c.id])).rejects.toThrow(/locked/);
  });
});

describe('a result below the quorum is flagged', () => {
  it('in the results, the CSV, Excel and PDF (for the team), and the voter results route is gone', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await vote(admin, { quorum: 75, votes: 2 });                                              // needs 3 of 4
    const r = (await admin.get(`/api/campaigns/${c.id}/results`).expect(200)).body;
    expect(r.quorum).toEqual({ percent: 75, eligible: 4, needed: 3, votes: 2, met: false });
    expect((await admin.get(`/api/campaigns/${c.id}/results.csv`).expect(200)).text).toContain('Quorum,NOT MET: 2 of 3 votes needed (75% of 4)');
    const bin = (res: import('superagent').Response, cb: (e: Error | null, b: Buffer) => void) => { const k: Buffer[] = []; res.on('data', (d: Buffer) => k.push(d)); res.on('end', () => cb(null, Buffer.concat(k))); };
    const x = await admin.get(`/api/campaigns/${c.id}/results.xlsx`).buffer(true).parse(bin).expect(200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.body as never);
    const cells: string[] = []; wb.getWorksheet('Summary')!.eachRow((rw) => cells.push(String(rw.getCell(2).value)));
    expect(cells.some((t) => t.startsWith('NOT MET: 2 of 3 votes needed (75% of 4 eligible voters)'))).toBe(true);
    await admin.get(`/api/campaigns/${c.id}/results.pdf`).expect(200);
    await (await login(app, S1)).get(`/api/vote/${c.token}/results`).expect(404);                       // a voter cannot ask for results at all
  });

  it('announcing below quorum needs an acknowledgement, which is audited (no names); at quorum it does not', async () => {
    const admin = await login(app, ADMIN_A);
    const low = await vote(admin, { quorum: 75, votes: 2 });
    const r = await admin.post(`/api/campaigns/${low.id}/announce-winners`).send({}).expect(409);
    expect(r.body.code).toBe('below_quorum'); expect(r.body.error).toContain('Only 2 of the 3 votes needed');
    expect((await row(low.id)).winners_announced_at).toBeNull();
    await admin.post(`/api/campaigns/${low.id}/announce-winners`).send({ acknowledge_below_quorum: true }).expect(201);
    const a = (await ownerDb().query("SELECT details FROM audit_log WHERE campaign_id = $1 AND action = 'results.announce'", [low.id])).rows;
    expect(a).toHaveLength(1);
    expect(a[0].details).toMatchObject({ positions: 1, winners: 1, below_quorum: true });
    expect(JSON.stringify(a[0].details)).not.toMatch(/One|Two/);                                         // counts and a hash only: nobody is named
    const ok = await vote(admin, { quorum: 75, votes: 3 });
    expect((await admin.get(`/api/campaigns/${ok.id}/results`)).body.quorum).toMatchObject({ met: true });
    await admin.post(`/api/campaigns/${ok.id}/announce-winners`).send({}).expect(201);
  });
});

describe('announcing the winners', () => {
  const announce = (a: Admin, id: string, body: object = {}) => a.post(`/api/campaigns/${id}/announce-winners`).send(body);

  it('records who and when and what, shows it in the admin results and exports, and is refused a second time', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await vote(admin, { votes: 2 });
    const pv = (await admin.get(`/api/campaigns/${c.id}/announcement`).expect(200)).body;
    expect(pv).toMatchObject({ available: true, announced: null, blocks: [], positions: [{ winners: ['One'], tie: null }] });
    expect(pv.text).toContain('Result: Quorum vote'); expect(pv.text).toContain('One');
    expect(pv.text).not.toMatch(/\d+ votes?|turnout|%/i);                                                // names only
    expect(pv.email).toMatchObject({ available: false });                                                // the email option is a disabled stub
    await announce(admin, c.id).expect(201);
    const r = await row(c.id);
    expect(r).toMatchObject({ winners_announced_by: ADMIN_A.oid });
    expect(r.winners_announcement).toEqual({ text: pv.text, positions: [{ title: pv.positions[0].title, winners: ['One'] }] });
    expect((await admin.get(`/api/campaigns/${c.id}/results`)).body.publication).toMatchObject({ by: ADMIN_A.displayName });
    expect((await admin.get(`/api/campaigns/${c.id}/results.csv`)).text).toContain(`Winners announced by,${ADMIN_A.displayName} on `);
    const again = await announce(admin, c.id).expect(409);
    expect(again.body.code).toBe('already_announced');
    expect((await ownerDb().query("SELECT count(*)::int AS n FROM audit_log WHERE campaign_id = $1 AND action = 'results.announce'", [c.id])).rows[0].n).toBe(1);   // one audit entry
    expect((await ownerDb().query("SELECT count(*)::int AS n FROM audit_log WHERE campaign_id = $1 AND action IN ('results.publish', 'results.publish_scheduled')", [c.id])).rows[0].n).toBe(0);
  });

  it('two simultaneous requests: exactly one announces, the others are refused (the one-time claim)', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await vote(admin, { votes: 2 });
    const rs = await Promise.all([announce(admin, c.id), announce(admin, c.id), announce(admin, c.id)]);
    expect(rs.map((x) => x.status).sort()).toEqual([201, 409, 409]);
    expect((await ownerDb().query("SELECT count(*)::int AS n FROM audit_log WHERE campaign_id = $1 AND action = 'results.announce'", [c.id])).rows[0].n).toBe(1);
  });

  it('is refused while the campaign is open, and for a TIED position ("Tied: create a run-off"), and the preview carries no text', async () => {
    const admin = await login(app, ADMIN_A);
    const open = await vote(admin, { votes: 1, close: false });
    expect((await announce(admin, open.id).expect(409)).body.code).toBe('not_closed');
    expect((await admin.get(`/api/campaigns/${open.id}/announcement`).expect(200)).body).toMatchObject({ available: false });

    const e = await makeElection(admin, { positions: [{ title: 'Chair', candidates: ['Ann', 'Ben'] }, { title: 'Treasurer', candidates: ['Cy', 'Dee'] }], start: true });
    const [s1, s2] = await Promise.all([S1, S2].map((u) => login(app, u)));
    const at = (p: number, c: number) => ({ candidateId: e.positions[p].candidates[c].id });
    await s1.post(`/api/vote/${e.token}/positions/${e.positions[0].id}`).send(at(0, 0)).expect(201);
    await s2.post(`/api/vote/${e.token}/positions/${e.positions[0].id}`).send(at(0, 1)).expect(201);   // Chair: 1-1, a tie
    await s1.post(`/api/vote/${e.token}/positions/${e.positions[1].id}`).send(at(1, 0)).expect(201);
    await s2.post(`/api/vote/${e.token}/positions/${e.positions[1].id}`).send(at(1, 0)).expect(201);
    await admin.post(`/api/campaigns/${e.id}/close`).send({ reason: 'Closing for the test run' }).expect(200);
    const pv = (await admin.get(`/api/campaigns/${e.id}/announcement`).expect(200)).body;
    expect(pv.blocks).toEqual([{ code: 'tied', message: 'Tied: create a run-off', positions: ['Chair'] }]);
    expect(pv.text).toBe('');
    expect(pv.positions.find((p: { title: string }) => p.title === 'Chair')).toMatchObject({ winners: [], tie: ['Ann', 'Ben'] });
    const r = await announce(admin, e.id).expect(409);
    expect([r.body.code, r.body.error]).toEqual(['tied', 'Tied: create a run-off']);
    expect((await row(e.id)).winners_announced_at).toBeNull();
  });

  it('a campaign nobody voted in announces "no winner (no votes were cast)"', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await vote(admin, { votes: 0 });
    const pv = (await admin.get(`/api/campaigns/${c.id}/announcement`).expect(200)).body;
    expect(pv.text).toContain('no winner (no votes were cast)');
    await announce(admin, c.id, { acknowledge_below_quorum: true }).expect(201);
  });

  it('a result that no longer matches its seal is refused', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await vote(admin, { votes: 2 });
    await ownerDb().query('ALTER TABLE tallies DISABLE TRIGGER USER');
    try { await ownerDb().query('UPDATE tallies SET votes = votes + 1 WHERE campaign_id = $1', [c.id]); } finally { await ownerDb().query('ALTER TABLE tallies ENABLE TRIGGER USER'); }
    const r = await announce(admin, c.id).expect(409);
    expect(r.body.code).toBe('integrity_failed');
    expect((await row(c.id)).winners_announced_at).toBeNull();
  });

  it('the database refuses to alter or withdraw an announcement, an announcement without who and what, and one for an open campaign', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await vote(admin, { votes: 2 });
    await expect(appRole.query('UPDATE campaigns SET winners_announced_at = now() WHERE id = $1', [c.id])).rejects.toThrow(/who announced, when, and what/);
    await announce(admin, c.id).expect(201);
    await expect(appRole.query('UPDATE campaigns SET winners_announcement = $2 WHERE id = $1', [c.id, '{}'])).rejects.toThrow(/cannot be altered or withdrawn/);
    await expect(appRole.query('UPDATE campaigns SET winners_announced_at = NULL WHERE id = $1', [c.id])).rejects.toThrow(/cannot be altered or withdrawn/);
    const open = await vote(admin, { votes: 1, close: false });
    await expect(appRole.query('UPDATE campaigns SET winners_announced_at = now(), winners_announced_by = $2, winners_announcement = $3 WHERE id = $1', [open.id, ADMIN_A.oid, '{}'])).rejects.toThrow(/closed campaign/);
  });

  it('a reset of the votes voids the announcement', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await vote(admin, { votes: 2 });
    await announce(admin, c.id).expect(201);
    await admin.post(`/api/campaigns/${c.id}/reset`).send({ confirm_title: 'Quorum vote', reason: 'A mistake in the voter list' }).expect(200);
    expect(await row(c.id)).toMatchObject({ winners_announced_at: null, winners_announced_by: null, winners_announcement: null });
  });

  it('only the creator or a co-admin can announce', async () => {
    const admin = await login(app, ADMIN_A); const other = await login(app, ADMIN_B); const staff = await login(app, S1);
    const c = await vote(admin, { votes: 2 });
    await announce(other, c.id).expect(404);
    await announce(staff, c.id).expect(403);
    await other.get(`/api/campaigns/${c.id}/announcement`).expect(404);
    await admin.post(`/api/campaigns/${c.id}/team`).send({ email: ADMIN_B.email, role: 'co_admin' }).expect(201);
    await announce(other, c.id).expect(201);
    expect((await row(c.id)).winners_announced_by).toBe(ADMIN_B.oid);
  });

  it('shows the announcement ONLY to people who voted, as names with no counts; publishing and scheduling no longer exist', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await vote(admin, { votes: 2 });                                                           // S1 and S2 voted; S3 and S4 are eligible but did not
    const before = (await (await login(app, S1)).get(`/api/vote/${c.token}`).expect(200)).body;
    expect(before.announcement).toBeNull();
    await announce(admin, c.id).expect(201);
    const voted = (await (await login(app, S1)).get(`/api/vote/${c.token}`).expect(200)).body;
    expect(voted.announcement).toMatchObject({ positions: [{ winners: ['One'] }] });
    expect(JSON.stringify(voted.announcement)).not.toMatch(/"votes"|turnout|tally|\d+ votes?/i);
    const notVoted = (await (await login(app, S3)).get(`/api/vote/${c.token}`).expect(200)).body;
    expect(notVoted.announcement).toBeNull();                                                            // no receipt, no announcement
    await admin.post(`/api/campaigns/${c.id}/publish`).send({}).expect(404);
    await admin.put(`/api/campaigns/${c.id}/publish-schedule`).send({ publish_at: new Date(Date.now() + 7200_000).toISOString() }).expect(404);
  });
});
