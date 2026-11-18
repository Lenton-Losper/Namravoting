// The Umoja member import (server/src/importMembers.ts): upsert by Employee Code, idempotent, never deletes, dry run changes nothing, audited
// with counts and the file's SHA-256, and nothing personal in its output. FAKE data only.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { importMembers } from '../../src/umoja/memberImport.js';
import { parseMemberFile } from '../../src/umoja/memberFile.js';
import { TEST_OWNER_URL, closeOwner, ownerDb, resetDb } from '../helpers.js';
import { pgc } from '../testDb.js';
import { cleanup, xlsxFile } from '../memberFixtures.js';

beforeEach(resetDb);
afterAll(async () => { cleanup(); await closeOwner(); });

const FILE = [
  ['ABC0001', 'Fake Person One', 'one@namra.org.na'], ['ABC0002', 'Fake Person Two', 'two@namra.org.na'], ['ABC0003', 'Fake Person Three', 'three@namra.org.na'],
  ['ABC0004', 'Bad Mail', 'four@example.com'],
];
const members = async () => (await ownerDb().query('SELECT employee_code, active, email, entra_oid FROM umoja_members ORDER BY employee_code')).rows;
/** One dedicated connection per run: the import is a transaction (BEGIN ... COMMIT), which a pool would spread over several connections. */
async function withClient<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> { const c = new pg.Client(pgc(TEST_OWNER_URL)); await c.connect(); try { return await fn(c); } finally { await c.end(); } }
const run = async (rows: unknown[][], dryRun = false) => { const f = await parseMemberFile(await xlsxFile(rows)); return withClient((c) => importMembers(c, f, { dryRun })); };
const audits = async () => (await ownerDb().query("SELECT actor_oid, details FROM audit_log WHERE action = 'umoja.members_import' ORDER BY seq")).rows;

describe('the import', () => {
  it('adds new members (active, with their address) and counts what it rejected', async () => {
    const r = await run(FILE);
    expect(r.counts).toEqual({ rows_read: 4, added: 3, updated: 0, unchanged: 0, rejected: 1, duplicates: 0 });
    expect(r.rejectedRows).toEqual([{ row: 5, reason: 'email is not @namra.org.na' }]);
    expect(await members()).toEqual([
      { employee_code: 'ABC0001', active: true, email: 'one@namra.org.na', entra_oid: null },
      { employee_code: 'ABC0002', active: true, email: 'two@namra.org.na', entra_oid: null },
      { employee_code: 'ABC0003', active: true, email: 'three@namra.org.na', entra_oid: null }]);
  });

  it('is safe to run twice: the second run changes nothing', async () => {
    await run(FILE);
    const before = await members();
    const again = await run(FILE);
    expect(again.counts).toMatchObject({ added: 0, updated: 0, unchanged: 3, rejected: 1 });
    expect(await members()).toEqual(before);
  });

  it('an updated list: a changed address is UPDATED, a new person ADDED, the rest unchanged', async () => {
    await run(FILE);
    const r = await run([['ABC0001', 'x', 'one@namra.org.na'], ['ABC0002', 'x', 'two.new@namra.org.na'], ['ABC0005', 'x', 'five@namra.org.na']]);
    expect(r.counts).toMatchObject({ added: 1, updated: 1, unchanged: 1, rejected: 0 });
    expect((await members()).map((m) => [m.employee_code, m.email])).toEqual([
      ['ABC0001', 'one@namra.org.na'], ['ABC0002', 'two.new@namra.org.na'], ['ABC0003', 'three@namra.org.na'], ['ABC0005', 'five@namra.org.na']]);
  });

  it('NEVER deletes: members missing from the new list stay, and an existing member keeps its active flag and Entra match', async () => {
    await ownerDb().query("INSERT INTO umoja_members (employee_code, active) VALUES ('OLD0001', false), ('OLD0002', true)");
    const oid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    await ownerDb().query("INSERT INTO users (entra_oid, email, display_name) VALUES ($1, 'matched@namra.org.na', 'Matched')", [oid]);
    await ownerDb().query("UPDATE umoja_members SET entra_oid = $1, email = 'matched@namra.org.na' WHERE employee_code = 'OLD0002'", [oid]);
    await ownerDb().query("INSERT INTO umoja_members (employee_code, active) VALUES ('ABC0001', false)");   // listed in the file, but inactive in the table
    await run(FILE);
    const m = await members();
    expect(m.map((x) => x.employee_code)).toEqual(['ABC0001', 'ABC0002', 'ABC0003', 'OLD0001', 'OLD0002']);
    expect(m.find((x) => x.employee_code === 'OLD0002')).toMatchObject({ active: true, entra_oid: oid, email: 'matched@namra.org.na' });
    expect(m.find((x) => x.employee_code === 'ABC0001')).toMatchObject({ active: false, email: 'one@namra.org.na' });   // the file sets the address, not membership status
  });

  it('an address that already belongs to a different member rejects that row only', async () => {
    await run([['ABC0001', 'x', 'one@namra.org.na']]);
    const r = await run([['ABC0009', 'x', 'one@namra.org.na'], ['ABC0010', 'x', 'ten@namra.org.na']]);
    expect(r.counts).toMatchObject({ added: 1, rejected: 1 });
    expect(r.rejectedRows).toEqual([{ row: 2, reason: 'email address already belongs to another member' }]);
    expect((await members()).map((x) => x.employee_code)).toEqual(['ABC0001', 'ABC0010']);
  });

  it('the database itself keeps an address unique', async () => {
    await run([['ABC0001', 'x', 'one@namra.org.na']]);
    await expect(ownerDb().query("INSERT INTO umoja_members (employee_code, active, email) VALUES ('ABC0002', true, 'one@namra.org.na')")).rejects.toThrow(/umoja_members_email_key|unique/);
  });
});

describe('dry run', () => {
  it('gives the counts a real run would give, changes nothing and writes no audit entry', async () => {
    await run([['ABC0001', 'x', 'one@namra.org.na']]);
    const before = await members(); const auditsBefore = (await audits()).length;
    const dry = await run([['ABC0001', 'x', 'one.changed@namra.org.na'], ['ABC0002', 'x', 'two@namra.org.na']], true);
    expect(dry.counts).toMatchObject({ added: 1, updated: 1, unchanged: 0 });
    expect(await members()).toEqual(before);
    expect(await audits()).toHaveLength(auditsBefore);
    const real = await run([['ABC0001', 'x', 'one.changed@namra.org.na'], ['ABC0002', 'x', 'two@namra.org.na']]);
    expect(real.counts).toEqual(dry.counts);
  });
});

describe('the audit entry', () => {
  it('holds the counts and the SHA-256 of the file, and nothing personal', async () => {
    const parsed = await parseMemberFile(await xlsxFile(FILE));
    await withClient((c) => importMembers(c, parsed, { dryRun: false }));
    const a = await audits();
    expect(a).toHaveLength(1);
    expect(a[0].actor_oid).toBeNull();
    expect(a[0].details).toEqual({ rows_read: 4, added: 3, updated: 0, unchanged: 0, rejected: 1, duplicates: 0, file_sha256: parsed.sha256 });
    expect(JSON.stringify(a[0].details)).not.toMatch(/ABC000|namra|Fake/);
  });
  it('a real run that fails halfway changes nothing (one transaction)', async () => {
    await ownerDb().query("INSERT INTO umoja_members (employee_code, active, email) VALUES ('ABC0002', true, 'two@namra.org.na')");
    const parsed = await parseMemberFile(await xlsxFile(FILE));
    const c = new pg.Client(pgc(TEST_OWNER_URL)); await c.connect();
    const real = c.query.bind(c);
    // make the audit insert fail, after the members were written
    (c as unknown as { query: typeof c.query }).query = ((sql: unknown, ...rest: unknown[]) => (typeof sql === 'string' && sql.includes("'umoja.members_import'") ? Promise.reject(new Error('boom')) : (real as (...a: unknown[]) => unknown)(sql, ...rest))) as typeof c.query;
    await expect(importMembers(c, parsed, { dryRun: false })).rejects.toThrow('boom');
    await c.end();
    expect((await members()).map((m) => m.employee_code)).toEqual(['ABC0002']);
  });
});

describe('the command line', () => {
  const server = path.resolve(import.meta.dirname, '../..');
  const cli = async (args: string[], env: Record<string, string> = {}) => {
    const f = await xlsxFile(FILE);
    return spawnSync('npx', ['tsx', 'src/importMembers.ts', f, ...args], {
      cwd: server, shell: true, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, NODE_ENV: 'production', MIGRATE_DATABASE_URL: TEST_OWNER_URL, ...env },
    });
  };
  it('--dry-run, then the real run, then a second run: counts only, no name, address or code on screen', async () => {
    const dry = await cli(['--dry-run']);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.stdout).toMatch(/DRY RUN \(nothing was changed\)[^]*added:\s+3[^]*rejected:\s+1[^]*row 5: email is not @namra\.org\.na/);
    expect(await members()).toEqual([]);
    const real = await cli([]);
    expect(real.stdout).toMatch(/IMPORT DONE[^]*added:\s+3[^]*updated:\s+0[^]*unchanged:\s+0/);
    const again = await cli([]);
    expect(again.stdout).toMatch(/added:\s+0[^]*updated:\s+0[^]*unchanged:\s+3/);
    for (const out of [dry.stdout, real.stdout, again.stdout, dry.stderr, real.stderr]) expect(out).not.toMatch(/ABC000|Fake Person|[a-z]@namra|example\.com/);
  });
  it('--check-file needs no database at all', async () => {
    const r = await cli(['--check-file'], { MIGRATE_DATABASE_URL: '' });
    expect(r.stdout).toMatch(/Check only \(no database contacted\): 4 rows read, 3 valid, 1 rejected/);
    expect(r.status).toBe(2);   // exit code 2: rejected rows exist
  });
  it('refuses a public cloud database before reading anything', async () => {
    const r = await cli([], { MIGRATE_DATABASE_URL: 'postgres://o:p@ep-x.aws.neon.tech/namra' });
    expect(r.status).toBe(1); expect(r.stderr).toMatch(/Refusing to import/);
    expect(r.stdout).not.toMatch(/SHA-256/);
  });
});
