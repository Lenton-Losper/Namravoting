import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { MemberFileError, parseMemberFile } from '../../src/umoja/memberFile.js';
import { assertMemberImportAllowed } from '../../src/umoja/memberImport.js';
import { cleanup, csvFile, xlsxFile } from '../memberFixtures.js';

afterAll(cleanup);

const GOOD = [['ABC0001', 'Test Person One', ' Person.One@NamRA.org.na '], ['abc0002', 'Test Person Two', 'person.two@namra.org.na']];

describe('reading the member file', () => {
  it('reads an xlsx: codes upper-cased, emails trimmed and lower-cased, display names dropped', async () => {
    const r = await parseMemberFile(await xlsxFile(GOOD));
    expect(r.members).toEqual([{ row: 2, code: 'ABC0001', email: 'person.one@namra.org.na' }, { row: 3, code: 'ABC0002', email: 'person.two@namra.org.na' }]);
    expect(JSON.stringify(r)).not.toContain('Test Person');
    expect(r).toMatchObject({ rowsRead: 2, rejected: [], duplicates: 0 });
  });
  it('reads a csv (BOM, quotes, CRLF, semicolons) the same way', async () => {
    for (const delim of [',', ';']) {
      const r = await parseMemberFile(csvFile([['ABC0001', 'Person, "One"', 'person.one@namra.org.na']], undefined, delim));
      expect(r.members).toEqual([{ row: 2, code: 'ABC0001', email: 'person.one@namra.org.na' }]);
    }
  });
  it('finds the columns by name in any order, with other columns around them', async () => {
    const f = await xlsxFile([['x', 'person.one@namra.org.na', 'Test One', 'ABC0001', 'junk']], ['Notes', 'Email Address', 'Display Name', 'Employee Code', 'Other']);
    expect((await parseMemberFile(f)).members).toEqual([{ row: 2, code: 'ABC0001', email: 'person.one@namra.org.na' }]);
  });
  it('reads an address stored as a hyperlink cell', async () => {
    const f = await xlsxFile([['ABC0001', 'Test One', { text: 'person.one@namra.org.na', hyperlink: 'mailto:person.one@namra.org.na' }]]);
    expect((await parseMemberFile(f)).members[0].email).toBe('person.one@namra.org.na');
  });
  it('the SHA-256 is that of the file bytes', async () => {
    const f = await xlsxFile(GOOD);
    expect((await parseMemberFile(f)).sha256).toBe(crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
  });
});

describe('rejected rows are named by row number and reason, never by content', () => {
  it('invalid code, invalid email, and an email outside @namra.org.na', async () => {
    const r = await parseMemberFile(await xlsxFile([
      ['ABC0001', 'Good One', 'good.one@namra.org.na'],
      ['AB1', 'Bad Code', 'bad.code@namra.org.na'],
      ['ABC0003', 'Bad Mail', 'not-an-email'],
      ['ABC0004', 'Outside', 'someone@gmail.com'],
      ['ABC0005', 'Sub', 'someone@sub.namra.org.na'],
      ['', '', ''],
      ['ABC0006', 'No mail', ''],
    ]));
    expect(r.members.map((m) => m.row)).toEqual([2]);
    expect(r.rejected).toEqual([
      { row: 3, reason: 'invalid employee code' }, { row: 4, reason: 'invalid email address' },
      { row: 5, reason: 'email is not @namra.org.na' }, { row: 6, reason: 'email is not @namra.org.na' }, { row: 8, reason: 'invalid email address' }]);
    expect(JSON.stringify(r.rejected)).not.toMatch(/gmail|Bad|someone/);
    expect(r.rowsRead).toBe(6);
  });
  it('a repeated identical row is ignored; conflicting repeats are rejected', async () => {
    const r = await parseMemberFile(await xlsxFile([
      ['ABC0001', 'One', 'one@namra.org.na'], ['ABC0001', 'One again', 'ONE@namra.org.na'],
      ['ABC0001', 'One', 'other@namra.org.na'], ['ABC0002', 'Two', 'one@namra.org.na']]));
    expect(r.members.map((m) => m.row)).toEqual([2]);
    expect(r.duplicates).toBe(1);
    expect(r.rejected).toEqual([{ row: 4, reason: 'employee code appears earlier with a different email' }, { row: 5, reason: 'email address is already used by another employee code' }]);
  });
});

describe('a file that cannot be used', () => {
  it('a missing column', async () => {
    await expect(parseMemberFile(await xlsxFile([['ABC0001', 'One']], ['Employee Code', 'Display Name']))).rejects.toThrow(/Missing column: Email Address/);
  });
  it('no header at all', async () => {
    await expect(parseMemberFile(await xlsxFile([['ABC0001', 'One', 'one@namra.org.na']], null))).rejects.toThrow(/header row/);
  });
  it('the wrong kind of file', async () => {
    const t = csvFile([]).replace(/\.csv$/, '.txt'); fs.writeFileSync(t, 'x');
    const e = await parseMemberFile(t).catch((x) => x);
    expect(e).toBeInstanceOf(MemberFileError); expect(e.message).toMatch(/\.xlsx or a \.csv/);
  });
  it('an unreadable path says so without echoing it', async () => {
    await expect(parseMemberFile('/nowhere/at/all.xlsx')).rejects.toThrow(/Cannot read the file: ENOENT/);
  });
});

describe('where the list may be loaded', () => {
  const ok = (u: string) => expect(() => assertMemberImportAllowed(u, false)).not.toThrow();
  const no = (u: string) => expect(() => assertMemberImportAllowed(u, false)).toThrow(/Refusing to import/);
  it('this machine, the Docker "db" service, a private address and a NamRA host are fine', () => {
    ok('postgres://o:p@localhost:5433/namra'); ok('postgres://o:p@db:5432/namra'); ok('postgres://o:p@10.1.2.3:5432/namra'); ok('postgres://o:p@192.168.1.5/namra');
    ok('postgres://o:p@sql01.namra.org.na/namra');
  });
  it('a public cloud database is refused, unless --allow-remote', () => {
    no('postgres://o:p@ep-x.c-8.eu-central-1.aws.neon.tech/namra'); no('not a url'); no('postgres://o:p@8.8.8.8/namra');
    expect(() => assertMemberImportAllowed('postgres://o:p@ep-x.aws.neon.tech/namra', true)).not.toThrow();
  });
});
