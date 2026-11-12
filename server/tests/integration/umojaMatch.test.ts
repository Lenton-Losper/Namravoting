import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { applyConfirmedReport, applyMatches, type MatchResult } from '../../src/umoja/match.js';
import { importUmoja } from '../../src/umoja/import.js';
import { parseUmojaExport } from '../../src/umoja/parse.js';
import { ADMIN_A, S1, S2, S3, S4, TEST_APP_URL, TEST_OWNER_URL, closeOwner, login, makeCampaign, ownerDb, resetDb, setMembers } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

const result = (code: string, status: MatchResult['status'], oid: string | null, email: string | null, name = 'Zorblax Quentin'): MatchResult =>
  ({ code, name, active: true, status, oid, email, candidates: status === 'matched' ? 1 : 0 });
const withClient = async <T>(url: string, fn: (c: pg.Client) => Promise<T>): Promise<T> => { const c = new pg.Client({ connectionString: url }); await c.connect(); try { return await fn(c); } finally { await c.end(); } };
const row = async (code: string) => (await ownerDb().query('SELECT entra_oid, email, active FROM umoja_members WHERE employee_code = $1', [code])).rows[0];

describe('writing matches (owner role, one transaction)', () => {
  it('sets entra_oid + email for matched rows only; counts-only audit entry; no names anywhere', async () => {
    await setMembers([['NAM0001', true], ['NAM0002', true], ['NAM0003', true], ['NAM0004', true], ['NAM0005', true]]);
    const summary = await withClient(TEST_OWNER_URL, (c) => applyMatches(c, [
      result('NAM0001', 'matched', S1.oid, 's1@namra.org.na'),
      result('NAM0002', 'not_found', null, null),
      result('NAM0003', 'ambiguous', null, null),
      result('NAM0004', 'conflict', null, null),
      result('NAM0006', 'matched', S2.oid, 'ghost@namra.org.na'),   // matched, but not a member in the table
    ]));
    expect(summary).toEqual({ matched: 2, not_found: 1, ambiguous: 1, conflict: 1, updated: 1, not_in_db: 1 });
    expect(await row('NAM0001')).toMatchObject({ entra_oid: S1.oid, email: 's1@namra.org.na' });
    for (const c of ['NAM0002', 'NAM0003', 'NAM0004', 'NAM0005']) expect(await row(c)).toMatchObject({ entra_oid: null, email: null });
    const audit = (await ownerDb().query("SELECT actor_oid, details FROM audit_log WHERE action = 'umoja.match'")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].actor_oid).toBeNull();
    expect(audit[0].details).toEqual(summary);   // counts only
    const tables = (await ownerDb().query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).rows;
    for (const { table_name } of tables) {
      const dump = (await ownerDb().query(`SELECT t::text AS r FROM "${table_name}" t`)).rows.map((r) => r.r).join('\n');
      expect(dump, `${table_name} contains a name`).not.toMatch(/Zorblax|Quentin/);
    }
  });

  it('column assertion: umoja_members has no name column, and email is lower-case only', async () => {
    const cols = (await ownerDb().query("SELECT column_name FROM information_schema.columns WHERE table_name = 'umoja_members' ORDER BY column_name")).rows.map((r) => r.column_name);
    expect(cols).toEqual(['active', 'email', 'employee_code', 'entra_oid', 'imported_at']);
    await setMembers([['NAM0001', true]]);
    await expect(ownerDb().query("UPDATE umoja_members SET entra_oid = $1, email = 'MIXED@namra.org.na'", [S1.oid])).rejects.toThrow(/umoja_members_email_lower/);
    await expect(ownerDb().query("UPDATE umoja_members SET email = 'a@namra.org.na'")).rejects.toThrow(/umoja_members_email_needs_oid/);
  });

  it('is all-or-nothing: a failure rolls back every update and the audit entry', async () => {
    await setMembers([['NAM0001', true], ['NAM0002', true]]);
    await expect(withClient(TEST_OWNER_URL, (c) => applyMatches(c, [
      result('NAM0001', 'matched', S1.oid, 's1@namra.org.na'),
      result('NAM0002', 'matched', 'not-a-uuid', 'x@namra.org.na'),
    ]))).rejects.toThrow();
    expect(await row('NAM0001')).toMatchObject({ entra_oid: null, email: null });
    expect((await ownerDb().query("SELECT count(*)::int n FROM audit_log WHERE action = 'umoja.match'")).rows[0].n).toBe(0);
  });

  it('an account moves cleanly to a new code (the oid column is UNIQUE, so the old row is freed first)', async () => {
    await setMembers([['NAM0001', true], ['NAM0002', true]]);
    await withClient(TEST_OWNER_URL, (c) => applyMatches(c, [result('NAM0001', 'matched', S1.oid, 's1@namra.org.na')]));
    await withClient(TEST_OWNER_URL, (c) => applyMatches(c, [result('NAM0002', 'matched', S1.oid, 's1@namra.org.na')]));
    expect(await row('NAM0001')).toMatchObject({ entra_oid: null });
    expect(await row('NAM0002')).toMatchObject({ entra_oid: S1.oid });
  });

  it('the app role cannot write matches: SELECT only on umoja_members', async () => {
    await setMembers([['NAM0001', true]]);
    await withClient(TEST_APP_URL, async (c) => {
      expect((await c.query('SELECT entra_oid, email FROM umoja_members')).rowCount).toBe(1);
      await expect(c.query('UPDATE umoja_members SET entra_oid = $1', [S1.oid])).rejects.toThrow(/permission denied/);
      await expect(c.query("UPDATE umoja_members SET email = 'x@y.z'")).rejects.toThrow(/permission denied/);
      await expect(c.query('DELETE FROM umoja_members')).rejects.toThrow(/permission denied/);
      await expect(c.query("INSERT INTO umoja_members (employee_code, active) VALUES ('NAM0009', true)")).rejects.toThrow(/permission denied/);
    });
  });

  it('re-running the HR import keeps existing matches and removes members that left the file', async () => {
    await setMembers([['NAM0001', true], ['NAM0002', true]]);
    await withClient(TEST_OWNER_URL, (c) => applyMatches(c, [result('NAM0001', 'matched', S1.oid, 's1@namra.org.na'), result('NAM0002', 'matched', S2.oid, 's2@namra.org.na')]));
    const file = ['Employee Code,Employee Name,Umoja Membership', 'NAM0001,A B,Inactive', 'NAM0003,C D,Active'].join('\n');
    await withClient(TEST_OWNER_URL, (c) => importUmoja(c, parseUmojaExport(file)));
    expect(await row('NAM0001')).toMatchObject({ entra_oid: S1.oid, email: 's1@namra.org.na', active: false });   // kept, status refreshed
    expect(await row('NAM0002')).toBeUndefined();                                                               // not in the file any more
    expect(await row('NAM0003')).toMatchObject({ entra_oid: null, active: true });
  });
});

describe('membership by Entra account id (oid)', () => {
  const noCode = (u: typeof S1) => ({ ...u, employeeCode: null });
  async function umojaVote() {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2, 'Oid vote', 'umoja');
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    return c;
  }
  const match = (code: string, oid: string) => ownerDb().query('UPDATE umoja_members SET entra_oid = $2, email = $3 WHERE employee_code = $1', [code, oid, 'm@namra.org.na']);

  it('POSITIVE CONTROL: a matched account with NO employee code can see the ballot, vote exactly once, and see it in My votes', async () => {
    await setMembers([['NAM0001', true]]);
    await match('NAM0001', S1.oid);
    const c = await umojaVote();
    const s = await login(app, noCode(S1));
    expect((await s.get('/api/session').expect(200)).body.user.employeeCode).toBeNull();
    expect((await s.get(`/api/vote/${c.token}`).expect(200)).body.voterState).toBe('can_vote');
    expect((await s.get('/api/vote').expect(200)).body.campaigns.map((x: { shareToken: string }) => x.shareToken)).toContain(c.token);
    await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
    await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(409);
  });

  it('an unmatched user with no code gets not_member on every path', async () => {
    await setMembers([['NAM0001', true]]);
    await match('NAM0001', S1.oid);
    const c = await umojaVote();
    const s = await login(app, noCode(S2));
    expect((await s.get(`/api/vote/${c.token}`).expect(403)).body.code).toBe('not_member');
    await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(403);
    expect((await s.get('/api/vote').expect(200)).body.campaigns).toEqual([]);
    expect((await s.get(`/api/vote/${c.token}/results`)).status).toBe(403);
  });

  it('a matched account whose member row is inactive is not_member', async () => {
    await setMembers([['NAM0001', false], ['NAM0002', true]]);
    await match('NAM0001', S1.oid);
    const c = await umojaVote();
    const s = await login(app, noCode(S1));
    expect((await s.get(`/api/vote/${c.token}`).expect(403)).body.code).toBe('not_member');
  });

  it('a forged oid or email in the request (headers, query, body) never grants membership; only the session identity counts', async () => {
    await setMembers([['NAM0001', true]]);
    await match('NAM0001', S1.oid);
    const c = await umojaVote();
    const s = await login(app, noCode(S3));
    const forged = { oid: S1.oid, entra_oid: S1.oid, email: 'm@namra.org.na' };
    await s.get(`/api/vote/${c.token}?oid=${S1.oid}&email=m@namra.org.na`).set('x-oid', S1.oid).set('x-ms-client-principal-id', S1.oid).set('x-email', 'm@namra.org.na').expect(403);
    const r = await s.post(`/api/vote/${c.token}?oid=${S1.oid}`).set('x-oid', S1.oid).send({ candidateId: c.candidates[0], ...forged });
    expect([400, 403]).toContain(r.status);
    expect((await s.get(`/api/vote?oid=${S1.oid}`).set('x-oid', S1.oid).expect(200)).body.campaigns).toEqual([]);
    expect((await ownerDb().query('SELECT coalesce(sum(votes), 0)::int n FROM tallies')).rows[0].n).toBe(0);
  });

  it('the employee-code path still works alongside it (for when IT fills in employeeId)', async () => {
    await setMembers([['NAM0101', true]]);
    const c = await umojaVote();
    const s = await login(app, { ...S4, employeeCode: 'NAM0101' });
    expect((await s.get(`/api/vote/${c.token}`).expect(200)).body.voterState).toBe('can_vote');
  });

  it('results: a matched member can read published results; an unmatched user cannot', async () => {
    await setMembers([['NAM0001', true]]);
    await match('NAM0001', S1.oid);
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2, 'Oid results', 'umoja');
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const member = await login(app, noCode(S1));
    await member.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
    await admin.post(`/api/campaigns/${c.id}/close`).expect(200);
    await admin.post(`/api/campaigns/${c.id}/publish`).expect(200);
    await member.get(`/api/vote/${c.token}/results`).expect(200);
    const other = await login(app, noCode(S2));
    expect((await other.get(`/api/vote/${c.token}/results`)).status).toBe(403);
  });
});

describe('SEC-22: only a human-confirmed report is applied', () => {
  const OID_A = S1.oid; const OID_B = S2.oid;
  const sheet = (...rows: string[]) => ['code,member_name,status,matched_email,oid,basis,candidates,other_candidates,confirm', ...rows].join('\n') + '\n';
  it('writes the oid and email of confirmed rows only, with a counts-only audit entry and no names anywhere', async () => {
    await setMembers([['NAM0001', true], ['NAM0002', true], ['NAM0003', true]]);
    const csv = sheet(
      `NAM0001,Zorblax Quentin,matched,z1@namra.org.na,${OID_A},exact_name,1,,yes`,
      `NAM0002,Wimbleton Quentin,matched,z2@namra.org.na,${OID_B},given_surname,1,,`,           // not confirmed
      `NAM0003,Quillon Dupe,ambiguous,,,,2,a@namra.org.na | b@namra.org.na,yes`);               // ambiguous: can never be applied
    const s = await withClient(TEST_OWNER_URL, (c) => applyConfirmedReport(c, csv));
    expect(s).toMatchObject({ updated: 1, ignored: 1, rejected: 1 });
    expect(await row('NAM0001')).toMatchObject({ entra_oid: OID_A, email: 'z1@namra.org.na' });
    expect(await row('NAM0002')).toMatchObject({ entra_oid: null, email: null });
    expect(await row('NAM0003')).toMatchObject({ entra_oid: null, email: null });
    const audit = (await ownerDb().query("SELECT details FROM audit_log WHERE action = 'umoja.match'")).rows;
    expect(audit).toHaveLength(1);
    const dump = (await ownerDb().query('SELECT t::text AS r FROM audit_log t')).rows.map((r) => r.r).join('\n') + (await ownerDb().query('SELECT t::text AS r FROM umoja_members t')).rows.map((r) => r.r).join('\n');
    expect(dump).not.toMatch(/Zorblax|Quentin|Quillon|Dupe/);
  });

  it('an unconfirmed report applies nothing and says so', async () => {
    await setMembers([['NAM0001', true]]);
    await expect(withClient(TEST_OWNER_URL, (c) => applyConfirmedReport(c, sheet(`NAM0001,Z Q,matched,z@namra.org.na,${OID_A},exact_name,1,,`)))).rejects.toThrow(/No row is confirmed/);
    expect(await row('NAM0001')).toMatchObject({ entra_oid: null });
    expect((await ownerDb().query("SELECT count(*)::int n FROM audit_log WHERE action = 'umoja.match'")).rows[0].n).toBe(0);
  });
});
