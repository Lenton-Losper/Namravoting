import { describe, expect, it } from 'vitest';
import { normalizeEmployeeCode } from '../../src/domain/employeeCode.js';
import { parseUmojaExport, UmojaParseError } from '../../src/umoja/parse.js';

const HEADER = ['Employee Code', 'Employee Name', 'Umoja Membership', 'Date Joined', 'Active Months', 'Gender', 'Position', 'Business Unit'];
const block = (code: string, status: string, name = 'Jane Secretname') => [code, name, status, '2019-03-01', '12', 'Female', 'Senior Clerk', 'Domestic Taxes'];
const asLines = (...rows: string[][]) => [...HEADER, ...rows.flat()].join('\n');
const asCsv = (...rows: string[][]) => [HEADER, ...rows].map((r) => r.map((f) => (/[",]/.test(f) ? `"${f.replaceAll('"', '""')}"` : f)).join(',')).join('\n');

describe('normalizeEmployeeCode', () => {
  it('trims and upper-cases; rejects anything that is not 3 letters + 4 digits', () => {
    expect(normalizeEmployeeCode('  tst0445 ')).toBe('TST0445');
    expect(normalizeEmployeeCode('TST0012')).toBe('TST0012');
    for (const bad of ['NAM445', 'NA0445', 'TST04456', 'N4M0445', '', 'NAM 0445', null, undefined, 5]) expect(normalizeEmployeeCode(bad)).toBeNull();
  });
});

describe('parseUmojaExport', () => {
  it('reads the one-value-per-line layout (header then blocks of 8)', () => {
    const r = parseUmojaExport(asLines(block('TST0445', 'Active'), block('TST0012', 'Inactive'), block('NAM0001', 'Terminated')));
    expect(r.layout).toBe('lines');
    expect(r.columns).toEqual(HEADER);
    expect(r.rowsRead).toBe(3);
    expect(r.members).toEqual([{ code: 'TST0445', active: true }, { code: 'TST0012', active: false }, { code: 'NAM0001', active: false }]);
  });

  it('reads normal CSV, including quoted fields with commas', () => {
    const r = parseUmojaExport(asCsv(block('TST0445', 'Active', 'Doe, Jane'), block('TST0446', 'Active')));
    expect(r.layout).toBe('csv');
    expect(r.columns).toEqual(HEADER);
    expect(r.members).toEqual([{ code: 'TST0445', active: true }, { code: 'TST0446', active: true }]);
  });

  it('handles CRLF, a BOM, and tab-separated files', () => {
    const tsv = '﻿' + [HEADER, block('TST0445', 'Active')].map((r) => r.join('\t')).join('\r\n') + '\r\n';
    expect(parseUmojaExport(tsv).members).toEqual([{ code: 'TST0445', active: true }]);
    expect(parseUmojaExport(asLines(block('TST0445', 'Active')).replaceAll('\n', '\r\n')).members).toHaveLength(1);
  });

  it('normalises lower-case and space-padded codes, and matches "Active" case-insensitively with padding', () => {
    for (const layout of [asLines, asCsv]) {
      const r = parseUmojaExport(layout(block('  tst0445 ', ' ACTIVE '), block('tst0012', 'active')));
      expect(r.members).toEqual([{ code: 'TST0445', active: true }, { code: 'TST0012', active: true }]);
    }
  });

  it('reports invalid codes (code values only) and does not import them', () => {
    const r = parseUmojaExport(asCsv(block('TST0445', 'Active'), block('BAD1', 'Active'), block('N/A', 'Active'), block('', 'Active')));
    expect(r.rowsRead).toBe(4);
    expect(r.invalid).toEqual(['BAD1', 'N/A', '']);
    expect(r.members).toEqual([{ code: 'TST0445', active: true }]);
  });

  it('counts duplicates; conflicting duplicates fail closed (inactive)', () => {
    const r = parseUmojaExport(asLines(block('TST0445', 'Active'), block('tst0445', 'Active'), block('NAM0500', 'Active'), block('NAM0500', 'Inactive')));
    expect(r.duplicates).toBe(2);
    expect(r.conflictingDuplicates).toBe(1);
    expect(r.members).toEqual([{ code: 'TST0445', active: true }, { code: 'NAM0500', active: false }]);
  });

  it('keeps nothing but code + flag: no name, gender, position or dates anywhere in the result', () => {
    const r = parseUmojaExport(asLines(block('TST0445', 'Active', 'Zebedee Uniquename'), block('BAD', 'Active', 'Other Uniquename')));
    const dump = JSON.stringify(r);
    for (const secret of ['Zebedee', 'Uniquename', 'Female', 'Senior Clerk', 'Domestic Taxes', '2019']) expect(dump).not.toContain(secret);
    expect(Object.keys(r.members[0]).sort()).toEqual(['active', 'code']);
  });

  it('tolerates blank lines used as separators in the line layout', () => {
    const text = [...HEADER, '', ...block('TST0445', 'Active'), '', ...block('TST0446', 'Inactive')].join('\n');
    expect(parseUmojaExport(text).members).toHaveLength(2);
  });

  it('accepts a footnote digit on a header ("Employee Code2") and a blank line after every value', () => {
    const cols = ['Employee Code2', ...HEADER.slice(1)];
    const text = [...cols, ...block('TST0445', 'Active'), ...block('TST0446', 'Inactive')].map((l) => l + '\n').join('\n');
    const r = parseUmojaExport(text);
    expect(r.columns[0]).toBe('Employee Code2');
    expect(r.members).toEqual([{ code: 'TST0445', active: true }, { code: 'TST0446', active: false }]);
    expect(r.irregularRecords).toBe(0);
  });

  it('copes with a record whose text wraps onto extra lines, anchoring on the code line', () => {
    const wrapped = block('TST0445', 'Active'); wrapped.splice(7, 0, 'Second line of a long position');
    const text = [...HEADER, ...wrapped, ...block('TST0446', 'Inactive'), ...block('TST0447', 'Active')].map((l) => l + '\n').join('\n');
    const r = parseUmojaExport(text);
    expect(r.members).toEqual([{ code: 'TST0445', active: true }, { code: 'TST0446', active: false }, { code: 'TST0447', active: true }]);
    expect(r.irregularRecords).toBe(1);
    expect(JSON.stringify(r)).not.toContain('Second line');
  });

  it('fails clearly on a missing column (listing the columns it saw) and on misaligned blocks', () => {
    expect(() => parseUmojaExport('Name,Gender\nA,B')).toThrow(/Columns seen: "Name", "Gender"/);
    expect(() => parseUmojaExport('')).toThrow(UmojaParseError);
    // values that cannot be tied to a code line are an error rather than a guess
    expect(() => parseUmojaExport([...HEADER, 'not a code', 'x', 'Active'].join('\n'))).toThrow(/do not divide into blocks of 8/);
    // a stray extra line after a record is treated as wrapped text, and reported
    expect(parseUmojaExport(asLines(block('TST0445', 'Active')) + '\nstray').irregularRecords).toBe(1);
  });
});
