// Business-logic item 10: the creator can add a late voter to a running vote, with a reason; it is audited and shown in the export.
import ExcelJS from 'exceljs';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { ADMIN_A, ADMIN_B, S1, S2, S3, closeOwner, login, makeCampaign, ownerDb, resetDb, setMembers } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

type Admin = Awaited<ReturnType<typeof login>>;
const REASON = 'Joined the organisation after voting began';
const bin = (res: import('superagent').Response, cb: (e: Error | null, b: Buffer) => void) => { const k: Buffer[] = []; res.on('data', (d: Buffer) => k.push(d)); res.on('end', () => cb(null, Buffer.concat(k))); };

async function listed(admin: Admin, emails: string[], start = true) {
  const c = (await admin.post('/api/campaigns').send({ title: 'Listed vote', eligibility: 'list', emails }).expect(201)).body;
  const cands: string[] = [];
  for (const n of ['One', 'Two']) cands.push((await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', n).expect(201)).body.id);
  if (start) await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
  return { id: c.id as string, token: c.share_token as string, cands };
}

describe('a listed vote', () => {
  it('a person who was not on the list cannot vote until they are added, then can', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await listed(admin, [S1.email]);
    const s2 = await login(app, S2);
    await s2.get(`/api/vote/${c.token}`).expect(403);
    await s2.post(`/api/vote/${c.token}`).send({ candidateId: c.cands[0] }).expect(403);
    expect((await admin.post(`/api/campaigns/${c.id}/late-voters`).send({ email: ` ${S2.email.toUpperCase()} `, reason: REASON }).expect(201)).body).toEqual({ added: true, email: S2.email });
    expect((await s2.get(`/api/vote/${c.token}`).expect(200)).body.voterState).toBe('can_vote');
    await s2.post(`/api/vote/${c.token}`).send({ candidateId: c.cands[0] }).expect(201);
  });

  it('is audited with who, why and the address, and shown on the Eligibility tab data', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await listed(admin, [S1.email]);
    await admin.post(`/api/campaigns/${c.id}/late-voters`).send({ email: S2.email, reason: REASON }).expect(201);
    const a = (await ownerDb().query("SELECT actor_oid, details FROM audit_log WHERE campaign_id = $1 AND action = 'voter.late_added'", [c.id])).rows;
    expect(a).toHaveLength(1); expect(a[0].actor_oid).toBe(ADMIN_A.oid); expect(a[0].details).toEqual({ mode: 'list', email: S2.email, reason: REASON });
    const g = (await admin.get(`/api/campaigns/${c.id}/late-voters`).expect(200)).body;
    expect(g).toMatchObject({ enabled: true, applicable: true, mode: 'list' });
    expect(g.entries).toEqual([expect.objectContaining({ by: ADMIN_A.displayName, identifier: S2.email, reason: REASON })]);
  });

  it('needs a reason, a valid address, and refuses a duplicate or the wrong kind of identifier', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await listed(admin, [S1.email]);
    const url = `/api/campaigns/${c.id}/late-voters`;
    await admin.post(url).send({ email: S2.email, reason: 'short' }).expect(400);
    await admin.post(url).send({ email: S2.email }).expect(400);
    await admin.post(url).send({ reason: REASON }).expect(400);
    await admin.post(url).send({ email: S2.email, employee_code: 'NAM0101', reason: REASON }).expect(400);
    expect((await admin.post(url).send({ email: 'not an address', reason: REASON }).expect(400)).body.code).toBe('bad_email');
    expect((await admin.post(url).send({ employee_code: 'NAM0101', reason: REASON }).expect(400)).body.code).toBe('needs_email');
    expect((await admin.post(url).send({ email: S1.email, reason: REASON }).expect(409)).body.code).toBe('already_listed');
    expect((await ownerDb().query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'voter.late_added'")).rows[0].n).toBe(0);   // nothing half-recorded
  });

  it('counts the new voter in the voter count the result is measured against', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await listed(admin, [S1.email]);
    await admin.post(`/api/campaigns/${c.id}/late-voters`).send({ email: S2.email, reason: REASON }).expect(201);
    await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
    expect((await admin.get(`/api/campaigns/${c.id}/results`).expect(200)).body.turnout.eligible).toBe(2);
  });
});

describe('an Umoja vote', () => {
  async function umoja() {
    await setMembers([['NAM0101', true], ['NAM0102', false]]);
    await login(app, { ...S1, employeeCode: 'NAM0101' });
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2, 'Umoja vote', 'umoja');
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    return { admin, ...c };
  }

  it('adds a member who joined (or was added to the imported list) after voting started', async () => {
    const { admin, id, token, candidates } = await umoja();
    await ownerDb().query("INSERT INTO umoja_members (employee_code, active) VALUES ('NAM0200', true)");       // the next HR import
    const s3 = await login(app, { ...S3, employeeCode: 'NAM0200' });
    expect((await s3.get(`/api/vote/${token}`)).status).toBe(403);                                              // not in the frozen list
    expect((await admin.post(`/api/campaigns/${id}/late-voters`).send({ employee_code: ' nam0200 ', reason: REASON }).expect(201)).body).toEqual({ added: true, employee_code: 'NAM0200' });
    expect((await s3.get(`/api/vote/${token}`).expect(200)).body.voterState).toBe('can_vote');
    await s3.post(`/api/vote/${token}`).send({ candidateId: candidates[0] }).expect(201);
    expect((await admin.get(`/api/campaigns/${id}/late-voters`)).body.entries[0]).toMatchObject({ identifier: 'NAM0200', reason: REASON });
  });

  it('refuses codes that are unknown, inactive, or already in the frozen list', async () => {
    const { admin, id } = await umoja();
    const url = `/api/campaigns/${id}/late-voters`;
    expect((await admin.post(url).send({ employee_code: 'NAM0999', reason: REASON }).expect(409)).body.code).toBe('not_a_member');
    expect((await admin.post(url).send({ employee_code: 'NAM0102', reason: REASON }).expect(409)).body.code).toBe('not_a_member');    // inactive on the roster
    expect((await admin.post(url).send({ employee_code: 'NAM0101', reason: REASON }).expect(409)).body.code).toBe('already_in_list');
    expect((await admin.post(url).send({ employee_code: 'garbage', reason: REASON }).expect(400)).body.code).toBe('bad_code');
    expect((await admin.post(url).send({ email: S2.email, reason: REASON }).expect(400)).body.code).toBe('needs_code');
  });
});

describe('when it is not allowed or not needed', () => {
  it('a vote open to all staff, a draft, and a closed vote', async () => {
    const admin = await login(app, ADMIN_A);
    const all = await makeCampaign(admin, 2, 'All staff', 'all');
    await admin.post(`/api/campaigns/${all.id}/start`).expect(200);
    expect((await admin.post(`/api/campaigns/${all.id}/late-voters`).send({ email: S2.email, reason: REASON }).expect(409)).body.code).toBe('not_applicable');
    expect((await admin.get(`/api/campaigns/${all.id}/late-voters`)).body).toMatchObject({ applicable: false });
    const draft = await listed(admin, [S1.email], false);
    expect((await admin.post(`/api/campaigns/${draft.id}/late-voters`).send({ email: S2.email, reason: REASON }).expect(409)).body.code).toBe('not_started');
    const done = await listed(admin, [S1.email]);
    await admin.post(`/api/campaigns/${done.id}/close`).send({}).expect(200);
    expect((await admin.post(`/api/campaigns/${done.id}/late-voters`).send({ email: S2.email, reason: REASON }).expect(409)).body.code).toBe('closed');
  });

  it('only the creator may add one (a co-admin may look at the list), never other admins or staff', async () => {
    const admin = await login(app, ADMIN_A); const other = await login(app, ADMIN_B); const staff = await login(app, S1);
    const c = await listed(admin, [S1.email]);
    await admin.post(`/api/campaigns/${c.id}/team`).send({ email: ADMIN_B.email, role: 'co_admin' }).expect(201);
    await other.post(`/api/campaigns/${c.id}/late-voters`).send({ email: S2.email, reason: REASON }).expect(404);
    await other.get(`/api/campaigns/${c.id}/late-voters`).expect(200);
    await staff.post(`/api/campaigns/${c.id}/late-voters`).send({ email: S2.email, reason: REASON }).expect(403);
    await staff.get(`/api/campaigns/${c.id}/late-voters`).expect(403);
  });
});

describe('the record', () => {
  it('late additions appear in the Excel history and in the audit bundle', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await listed(admin, [S1.email]);
    await admin.post(`/api/campaigns/${c.id}/late-voters`).send({ email: S2.email, reason: REASON }).expect(201);
    await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
    const x = await admin.get(`/api/campaigns/${c.id}/results.xlsx`).buffer(true).parse(bin).expect(200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.body as never);
    const rows: string[] = []; wb.getWorksheet('Event history')!.eachRow((r) => rows.push((r.values as unknown[]).slice(1).join('|')));
    expect(rows.some((l) => l.startsWith('Late voter added|') && l.includes(S2.email) && l.includes(REASON))).toBe(true);
    const { unzipStored } = await import('../../src/services/zip.js');
    const z = await admin.get(`/api/campaigns/${c.id}/audit-bundle.zip`).buffer(true).parse(bin).expect(200);
    const log = unzipStored(z.body as Buffer).find((e) => e.name === 'audit-log.csv')!.data.toString();
    expect(log).toContain('voter.late_added'); expect(log).toContain(REASON);
  });
});
