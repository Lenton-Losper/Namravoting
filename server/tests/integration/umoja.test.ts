import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { importUmoja } from '../../src/umoja/import.js';
import { parseUmojaExport } from '../../src/umoja/parse.js';
import { ADMIN_A, S1, S2, S3, S4, S5, TEST_APP_URL, TEST_OWNER_URL, closeOwner, count, login, makeCampaign, ownerDb, resetDb, setMembers } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

const member = { ...S1, employeeCode: 'NAM0101' };
const inactive = { ...S2, employeeCode: 'NAM0102' };
const unknown = { ...S3, employeeCode: 'NAM0777' };
const noCode = { ...S5, employeeCode: null };
const MEMBERS: [string, boolean][] = [['NAM0101', true], ['NAM0102', false], ['EXE0001', true]];

async function umojaVote() {
  await setMembers(MEMBERS);
  const admin = await login(app, ADMIN_A);
  const c = await makeCampaign(admin, 2, 'Umoja vote', 'umoja');
  await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
  return { admin, ...c };
}

describe('dev mode keeps the identity picker', () => {
  it('lists the seeded identities and signs in through /api/dev/login', async () => {
    const agent = (await import('supertest')).default.agent(app);
    const users = (await agent.get('/api/dev/users').expect(200)).body.users;
    expect(users.length).toBeGreaterThan(5);
    const s = await login(app, users[0]);
    expect((await s.get('/api/session').expect(200)).body).toMatchObject({ authMode: 'dev', user: { email: users[0].email } });
  });
});

describe('auth: employee code', () => {
  it('dev login stores a normalised code on the user; malformed values become null', async () => {
    await login(app, { ...S1, employeeCode: ' nam0101 ' });
    expect((await ownerDb().query('SELECT employee_code FROM users WHERE entra_oid = $1', [S1.oid])).rows[0].employee_code).toBe('NAM0101');
    await login(app, { ...S1, employeeCode: 'not-a-code' });
    expect((await ownerDb().query('SELECT employee_code FROM users WHERE entra_oid = $1', [S1.oid])).rows[0].employee_code).toBeNull();
    const s = await login(app, member);
    expect((await s.get('/api/session').expect(200)).body.user.employeeCode).toBe('NAM0101');
  });
});

describe('Umoja-only campaigns', () => {
  it('new campaigns default to umoja; the admin detail shows only a count', async () => {
    await setMembers(MEMBERS);
    const admin = await login(app, ADMIN_A);
    const c = (await admin.post('/api/campaigns').send({ title: 'Default mode' }).expect(201)).body;
    expect(c.eligibility).toBe('umoja');
    const d = (await admin.get(`/api/campaigns/${c.id}`).expect(200)).body;
    expect(d.umoja_active_count).toBe(2);
    expect(JSON.stringify(d)).not.toMatch(/NAM0101|EXE0001|NAM0102/);          // no codes, only the number
  });

  it('POSITIVE CONTROL: an active member sees can_vote and can vote exactly once', async () => {
    const c = await umojaVote();
    const s = await login(app, member);
    expect((await s.get(`/api/vote/${c.token}`).expect(200)).body.voterState).toBe('can_vote');
    await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
    await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(409);
    expect(await count('vote_receipts', c.id)).toBe(1);
    expect(await count('ballots', c.id)).toBe(1);
  });

  it.each([
    ['an inactive member', inactive],
    ['a code that is not on the list', unknown],
    ['a user with no employee code', noCode],
  ])('%s gets not_member (no campaign data) and the vote is refused', async (_n, user) => {
    const c = await umojaVote();
    const s = await login(app, user);
    const page = await s.get(`/api/vote/${c.token}`).expect(403);
    expect(page.body.code).toBe('not_member');
    const text = page.text;
    for (const leak of ['Umoja vote', 'Candidate 1', 'inactive', 'unknown', 'no_code', 'NAM0', 'candidates']) expect(text).not.toContain(leak);
    const post = await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(403);
    expect(post.body.code).toBe('not_member');
    await s.get(`/api/vote/${c.token}/results`).expect(403);
    expect(await count('vote_receipts', c.id)).toBe(0);
    expect(await count('ballots', c.id)).toBe(0);
  });

  it('logs the reason server-side (no code / unknown code / inactive) but never tells the voter', async () => {
    const c = await umojaVote();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await (await login(app, noCode)).get(`/api/vote/${c.token}`).expect(403);
      await (await login(app, unknown)).get(`/api/vote/${c.token}`).expect(403);
      await (await login(app, inactive)).post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(403);
      const lines = warn.mock.calls.map((a) => String(a[0]));
      expect(lines.some((l) => l.includes('reason=no_code'))).toBe(true);
      expect(lines.some((l) => l.includes('reason=unknown_code'))).toBe(true);
      expect(lines.some((l) => l.includes('reason=inactive'))).toBe(true);
      expect(lines.join('\n')).not.toMatch(/NAM0\d{3}/);                       // the code itself is not logged
    } finally { warn.mockRestore(); }
  });

  it('a forged employee_code in the query, headers or body is ignored', async () => {
    const c = await umojaVote();
    const s = await login(app, noCode);
    const forged = 'NAM0101';
    const q = `?employee_code=${forged}&employeeCode=${forged}`;
    const h = (r: ReturnType<typeof s.get>) => r.set('x-employee-code', forged).set('x-employeeid', forged).set('x-user-employee-code', forged);
    expect((await h(s.get(`/api/vote/${c.token}${q}`)).expect(403)).body.code).toBe('not_member');
    expect((await h(s.post(`/api/vote/${c.token}${q}`)).send({ candidateId: c.candidates[0] }).expect(403)).body.code).toBe('not_member');
    await h(s.get(`/api/vote/${c.token}/results${q}`)).expect(403);
    // In the body the strict schema rejects the extra field outright; either way nothing is recorded.
    const body = await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0], employee_code: forged, employeeCode: forged });
    expect([400, 403]).toContain(body.status);
    expect((await ownerDb().query('SELECT employee_code FROM users WHERE entra_oid = $1', [S5.oid])).rows[0].employee_code).toBeNull();
    expect(await count('vote_receipts', c.id)).toBe(0);
    // a non-member's My votes / photos stay empty too
    expect((await s.get(`/api/vote?employee_code=${forged}`).set('x-employee-code', forged).expect(200)).body.campaigns).toEqual([]);
  });

  it('My votes and photos follow membership (positive control + refusal)', async () => {
    const c = await umojaVote();
    const m = await login(app, member);
    const n = await login(app, unknown);
    expect((await m.get('/api/vote').expect(200)).body.campaigns.map((x: { shareToken: string }) => x.shareToken)).toEqual([c.token]);
    expect((await n.get('/api/vote').expect(200)).body.campaigns).toEqual([]);
  });

  it('membership is re-checked inside the vote transaction (status changes between page and POST)', async () => {
    const c = await umojaVote();
    const s = await login(app, member);
    expect((await s.get(`/api/vote/${c.token}`).expect(200)).body.voterState).toBe('can_vote');
    await setMembers([['NAM0101', false]]);                                     // HR sync deactivates them
    expect((await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(403)).body.code).toBe('not_member');
    expect(await count('vote_receipts', c.id)).toBe(0);
  });

  it('a campaign cannot be started with no active members loaded', async () => {
    await setMembers([['NAM0102', false]]);
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2, 'Empty', 'umoja');
    expect((await admin.post(`/api/campaigns/${c.id}/start`).expect(409)).body.code).toBe('needs_voters');
  });

  it('other modes are unaffected: "all" ignores membership', async () => {
    await setMembers([]);
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2, 'Everyone', 'all');
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    await (await login(app, noCode)).post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
  });
});

const HEADER = ['Employee Code', 'Employee Name', 'Umoja Membership', 'Date Joined', 'Active Months', 'Gender', 'Position', 'Business Unit'];
const row = (code: string, status: string, name: string) => [code, name, status, '2018-05-04', '77', 'Nonbinary-Test', 'Chief Pigeon Wrangler', 'Cloud Atlas Unit'];
const file = (...rows: string[][]) => [...HEADER, ...rows.flat()].join('\n');
const withClient = async <T>(fn: (c: pg.PoolClient) => Promise<T>) => { const c = await ownerDb().connect(); try { return await fn(c); } finally { c.release(); } };
const table = async () => (await ownerDb().query('SELECT employee_code, active FROM umoja_members ORDER BY employee_code')).rows;

describe('Umoja import', () => {
  it('is a full sync: members missing from a fresh file are removed, statuses update', async () => {
    await withClient((c) => importUmoja(c, parseUmojaExport(file(row('NAM0001', 'Active', 'A'), row('NAM0002', 'Active', 'B'), row('NAM0003', 'Active', 'C')))));
    expect(await table()).toEqual([{ employee_code: 'NAM0001', active: true }, { employee_code: 'NAM0002', active: true }, { employee_code: 'NAM0003', active: true }]);
    const s = await withClient((c) => importUmoja(c, parseUmojaExport(file(row('NAM0002', 'Inactive', 'B'), row('NAM0004', 'Active', 'D')))));
    expect(await table()).toEqual([{ employee_code: 'NAM0002', active: false }, { employee_code: 'NAM0004', active: true }]);
    expect(s).toMatchObject({ rows_read: 2, active: 1, inactive: 1, invalid: 0, duplicates: 0, removed: 3 });
  });

  it('is atomic and refuses an empty replacement (the old list survives)', async () => {
    await setMembers(MEMBERS);
    await expect(withClient((c) => importUmoja(c, parseUmojaExport(file(row('BAD', 'Active', 'X')))))).rejects.toThrow(/empty/);
    expect(await table()).toHaveLength(3);
  });

  it('stores no name, gender, position or dates anywhere: columns, audit details and a full-database scan', async () => {
    await withClient((c) => importUmoja(c, parseUmojaExport(file(row('NAM0001', 'Active', 'Zorblax Quentin'), row('BAD', 'Active', 'Wimbleton Prax')))));
    const cols = (await ownerDb().query("SELECT column_name FROM information_schema.columns WHERE table_name = 'umoja_members' ORDER BY column_name")).rows.map((r) => r.column_name);
    expect(cols).toEqual(['active', 'email', 'employee_code', 'entra_oid', 'imported_at']);   // still no name column

    const audit = (await ownerDb().query("SELECT details FROM audit_log WHERE action = 'umoja.import'")).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toEqual({ rows_read: 2, active: 1, inactive: 0, invalid: 1, duplicates: 0, removed: 0 });   // counts only
    const needles = ['Zorblax', 'Quentin', 'Wimbleton', 'Nonbinary', 'Pigeon', 'Cloud Atlas', '2018-05-04', 'BAD'];
    const tables = (await ownerDb().query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).rows;
    for (const { table_name } of tables) {
      const dump = (await ownerDb().query(`SELECT t::text AS r FROM "${table_name}" t`)).rows.map((r) => r.r).join('\n');
      for (const n of needles) expect(dump, `${table_name} contains ${n}`).not.toContain(n);
    }
  });

  it('the app DB role can SELECT but not INSERT, UPDATE or DELETE umoja_members', async () => {
    await setMembers(MEMBERS);
    const app = new pg.Client({ connectionString: TEST_APP_URL });
    await app.connect();
    try {
      expect((await app.query('SELECT count(*)::int AS n FROM umoja_members')).rows[0].n).toBe(3);       // positive control
      await expect(app.query("INSERT INTO umoja_members (employee_code, active) VALUES ('NAM9999', true)")).rejects.toThrow(/permission denied/);
      await expect(app.query('UPDATE umoja_members SET active = true')).rejects.toThrow(/permission denied/);
      await expect(app.query('DELETE FROM umoja_members')).rejects.toThrow(/permission denied/);
      await expect(app.query('TRUNCATE umoja_members')).rejects.toThrow(/permission denied/);
    } finally { await app.end(); }
    expect(await table()).toHaveLength(3);
  });

  it('npm script entry point (scripts/umoja-import.ts): reports columns/counts, syncs the table, prints no personal data', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'umoja-test-'));
    const f = path.join(dir, 'fake.umoja.txt');
    writeFileSync(f, file(row('nam0001', 'Active', 'Printable Person'), row('NAM0002', 'Inactive', 'Other Person'), row('oops', 'Active', 'Bad Row'), row('NAM0001', 'Active', 'Printable Person')));
    try {
      const r = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/umoja-import.ts', f], {
        cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8',
        env: { ...process.env, MIGRATE_DATABASE_URL: TEST_OWNER_URL, INIT_CWD: dir },
      });
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.stdout).toContain('Columns seen (8): Employee Code | Employee Name | Umoja Membership');
      expect(r.stdout).toMatch(/Rows read:\s+4/);
      expect(r.stdout).toMatch(/Active:\s+1/);
      expect(r.stdout).toMatch(/Inactive:\s+1/);
      expect(r.stdout).toMatch(/Invalid codes:\s+1\s+-> "oops"/);
      expect(r.stdout).toMatch(/Duplicates:\s+1/);
      for (const n of ['Printable', 'Person', 'Pigeon', 'Nonbinary']) expect(r.stdout + r.stderr).not.toContain(n);
      expect(await table()).toEqual([{ employee_code: 'NAM0001', active: true }, { employee_code: 'NAM0002', active: false }]);
      const dry = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/umoja-import.ts', f, '--dry-run'], { cwd: path.resolve(import.meta.dirname, '../..'), encoding: 'utf8', env: { ...process.env, MIGRATE_DATABASE_URL: '' } });
      expect(dry.status).toBe(0);
      expect(dry.stdout).toContain('Dry run');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
