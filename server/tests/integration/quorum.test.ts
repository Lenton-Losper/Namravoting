// Business-logic item 8: an optional quorum, scheduled publishing, and "published by".
import ExcelJS from 'exceljs';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { quorumOf } from '../../src/services/campaigns.js';
import { ADMIN_A, ADMIN_B, S1, S2, S3, S4, TEST_APP_URL, closeOwner, login, ownerDb, resetDb } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); await appRole.end(); });
const appRole = new pg.Pool({ connectionString: TEST_APP_URL, max: 1 });

type Admin = Awaited<ReturnType<typeof login>>;
const VOTERS = [S1, S2, S3, S4];
const hours = (n: number) => new Date(Date.now() + n * 3600_000).toISOString();

/** A listed vote for S1..S4 with the given quorum; `votes` of them vote; optionally closed. */
async function vote(admin: Admin, opts: { quorum?: number | null; votes: number; close?: boolean }) {
  const c = (await admin.post('/api/campaigns').send({ title: 'Quorum vote', eligibility: 'list', emails: VOTERS.map((v) => v.email), ...(opts.quorum ? { quorum_percent: opts.quorum } : {}) }).expect(201)).body;
  const cands: string[] = [];
  for (const n of ['One', 'Two']) cands.push((await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', n).expect(201)).body.id);
  await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
  for (let i = 0; i < opts.votes; i++) await (await login(app, VOTERS[i])).post(`/api/vote/${c.share_token}`).send({ candidateId: cands[0] }).expect(201);
  if (opts.close !== false) await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
  return { id: c.id as string, token: c.share_token as string };
}
const row = async (id: string) => (await ownerDb().query('SELECT results_published, published_at, published_by, publish_scheduled, publish_at FROM campaigns WHERE id = $1', [id])).rows[0];

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
    for (const n of ['One', 'Two']) await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', n).expect(201);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    expect((await admin.patch(`/api/campaigns/${c.id}`).send({ quorum_percent: 10 }).expect(409)).body.code).toBe('locked');   // even with "edits after start"
    await expect(appRole.query('UPDATE campaigns SET quorum_percent = 10 WHERE id = $1', [c.id])).rejects.toThrow(/locked/);
  });
});

describe('a result below the quorum is flagged', () => {
  it('in the results, the CSV, Excel and PDF, and for voters once published', async () => {
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
    await admin.post(`/api/campaigns/${c.id}/publish`).send({ acknowledge_below_quorum: true }).expect(200);
    const v = (await (await login(app, S1)).get(`/api/vote/${c.token}/results`).expect(200)).body;
    expect(v.quorum).toMatchObject({ met: false, needed: 3 });
  });

  it('publishing below quorum needs an acknowledgement, which is audited; at quorum it does not', async () => {
    const admin = await login(app, ADMIN_A);
    const low = await vote(admin, { quorum: 75, votes: 2 });
    const r = await admin.post(`/api/campaigns/${low.id}/publish`).send({}).expect(409);
    expect(r.body.code).toBe('below_quorum'); expect(r.body.error).toContain('Only 2 of the 3 votes needed');
    expect((await row(low.id)).results_published).toBe(false);
    await admin.post(`/api/campaigns/${low.id}/publish`).send({ acknowledge_below_quorum: true }).expect(200);
    const a = (await ownerDb().query("SELECT details FROM audit_log WHERE campaign_id = $1 AND action = 'results.publish'", [low.id])).rows;
    expect(a[0].details).toEqual({ below_quorum: true });
    const ok = await vote(admin, { quorum: 75, votes: 3 });
    expect((await admin.get(`/api/campaigns/${ok.id}/results`)).body.quorum).toMatchObject({ met: true });
    await admin.post(`/api/campaigns/${ok.id}/publish`).send({}).expect(200);
  });
});

describe('published by', () => {
  it('records who published and when, shows it to voters and in the exports, and the database refuses to change it', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await vote(admin, { votes: 2 });
    await admin.post(`/api/campaigns/${c.id}/publish`).send({}).expect(200);
    expect(await row(c.id)).toMatchObject({ results_published: true, published_by: ADMIN_A.oid, publish_scheduled: false });
    const v = (await (await login(app, S1)).get(`/api/vote/${c.token}/results`).expect(200)).body;
    expect(v.publication).toMatchObject({ by: ADMIN_A.displayName, scheduled: false });
    expect((await admin.get(`/api/campaigns/${c.id}/results.csv`)).text).toContain(`Published by,${ADMIN_A.displayName} on `);
    await expect(appRole.query('UPDATE campaigns SET published_by = NULL WHERE id = $1', [c.id])).rejects.toThrow(/cannot be altered/);
  });

  it('the database refuses a publication that does not say who and when', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await vote(admin, { votes: 2 });
    await expect(appRole.query('UPDATE campaigns SET results_published = true WHERE id = $1', [c.id])).rejects.toThrow(/who published and when/);
  });
});

describe('scheduled publishing', () => {
  it('publishes the closed result when the time has passed, the first time anyone looks, approved by the person who scheduled it', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await vote(admin, { votes: 2 });
    await admin.put(`/api/campaigns/${c.id}/publish-schedule`).send({ publish_at: hours(1) }).expect(200);
    await admin.get(`/api/campaigns/${c.id}`).expect(200);
    expect((await row(c.id)).results_published).toBe(false);                                            // not yet
    await ownerDb().query("UPDATE campaigns SET publish_at = now() - interval '1 minute' WHERE id = $1", [c.id]);
    await (await login(app, S2)).get('/api/vote').expect(200);                                         // a voter opening "My votes" is enough
    expect(await row(c.id)).toMatchObject({ results_published: true, published_by: ADMIN_A.oid, publish_scheduled: true });
    const a = (await ownerDb().query("SELECT actor_oid, details FROM audit_log WHERE campaign_id = $1 AND action = 'results.publish'", [c.id])).rows;
    expect(a).toHaveLength(1); expect(a[0].actor_oid).toBeNull(); expect(a[0].details).toEqual({ scheduled: true, approved_by: ADMIN_A.oid });
    expect((await (await login(app, S1)).get(`/api/vote/${c.token}/results`).expect(200)).body.publication).toMatchObject({ by: ADMIN_A.displayName, scheduled: true });
  });

  it('can be set before the vote closes, and publishes right after the close once its time has passed', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await vote(admin, { votes: 2, close: false });
    await admin.put(`/api/campaigns/${c.id}/publish-schedule`).send({ publish_at: hours(1) }).expect(200);
    await ownerDb().query("UPDATE campaigns SET publish_at = now() - interval '1 minute' WHERE id = $1", [c.id]);
    await admin.get(`/api/campaigns/${c.id}`).expect(200);
    expect((await row(c.id)).results_published).toBe(false);                                            // still open: never before the close
    await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
    await admin.get(`/api/campaigns/${c.id}`).expect(200);
    expect((await row(c.id)).results_published).toBe(true);
  });

  it('is not published automatically below the quorum or when the result no longer matches its seal: it is recorded once, and a person decides', async () => {
    const admin = await login(app, ADMIN_A);
    const low = await vote(admin, { quorum: 100, votes: 2 });
    await admin.put(`/api/campaigns/${low.id}/publish-schedule`).send({ publish_at: hours(1) }).expect(200);
    await ownerDb().query("UPDATE campaigns SET publish_at = now() - interval '1 minute' WHERE id = $1", [low.id]);
    await admin.get(`/api/campaigns/${low.id}`).expect(200); await admin.get(`/api/campaigns/${low.id}`).expect(200);
    expect((await row(low.id)).results_published).toBe(false);
    const b = (await ownerDb().query("SELECT details FROM audit_log WHERE campaign_id = $1 AND action = 'results.publish_blocked'", [low.id])).rows;
    expect(b.map((x) => x.details.reason)).toEqual(['below_quorum']);                                   // once, not per look
    await admin.post(`/api/campaigns/${low.id}/publish`).send({ acknowledge_below_quorum: true }).expect(200);

    const bad = await vote(admin, { votes: 2 });
    await admin.put(`/api/campaigns/${bad.id}/publish-schedule`).send({ publish_at: hours(1) }).expect(200);
    await ownerDb().query('UPDATE tallies SET votes = votes + 1 WHERE campaign_id = $1 AND votes > 0', [bad.id]);
    await ownerDb().query("UPDATE campaigns SET publish_at = now() - interval '1 minute' WHERE id = $1", [bad.id]);
    await admin.get(`/api/campaigns/${bad.id}`).expect(200);
    expect((await row(bad.id)).results_published).toBe(false);
    expect((await ownerDb().query("SELECT details FROM audit_log WHERE campaign_id = $1 AND action = 'results.publish_blocked'", [bad.id])).rows[0].details.reason).toBe('integrity_failed');
  });

  it('refuses a time in the past or a published campaign, can be cleared, and is audited', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await vote(admin, { votes: 2 });
    expect((await admin.put(`/api/campaigns/${c.id}/publish-schedule`).send({ publish_at: hours(-1) }).expect(400)).body.code).toBe('bad_time');
    await admin.put(`/api/campaigns/${c.id}/publish-schedule`).send({ publish_at: hours(2) }).expect(200);
    await admin.put(`/api/campaigns/${c.id}/publish-schedule`).send({ publish_at: null }).expect(200);
    expect((await row(c.id)).publish_at).toBeNull();
    expect((await ownerDb().query("SELECT action FROM audit_log WHERE campaign_id = $1 AND action LIKE 'results.publish_%' ORDER BY seq", [c.id])).rows.map((x) => x.action)).toEqual(['results.publish_scheduled', 'results.publish_unscheduled']);
    await admin.post(`/api/campaigns/${c.id}/publish`).send({}).expect(200);
    expect((await admin.put(`/api/campaigns/${c.id}/publish-schedule`).send({ publish_at: hours(2) }).expect(409)).body.code).toBe('already_published');
  });

  it('only the creator or a co-admin can schedule', async () => {
    const admin = await login(app, ADMIN_A); const other = await login(app, ADMIN_B); const staff = await login(app, S1);
    const c = await vote(admin, { votes: 2 });
    await other.put(`/api/campaigns/${c.id}/publish-schedule`).send({ publish_at: hours(2) }).expect(404);
    await staff.put(`/api/campaigns/${c.id}/publish-schedule`).send({ publish_at: hours(2) }).expect(403);
    await admin.post(`/api/campaigns/${c.id}/team`).send({ email: ADMIN_B.email, role: 'co_admin' }).expect(201);
    await other.put(`/api/campaigns/${c.id}/publish-schedule`).send({ publish_at: hours(2) }).expect(200);
    expect((await row(c.id)).publish_at).toBeTruthy();
    expect((await ownerDb().query('SELECT publish_scheduled_by FROM campaigns WHERE id = $1', [c.id])).rows[0].publish_scheduled_by).toBe(ADMIN_B.oid);   // the approver is who scheduled it
  });
});
