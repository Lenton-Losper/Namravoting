import { normalizeEmployeeCode } from '../domain/employeeCode.js';

/**
 * Parser for the HR Umoja export. PRIVACY: the file carries names, gender, position etc. The parser keeps ONLY
 * the employee code and the membership flag; every other field is read past and dropped, never stored or returned.
 *
 * Two layouts are supported:
 *  - CSV (also tab/semicolon separated) with a header row;
 *  - "one value per line": the header names one per line, then repeating blocks of N lines (N = number of columns).
 */
export interface ParsedMember { code: string; active: boolean }
export interface ParseResult {
  layout: 'csv' | 'lines';
  columns: string[];             // header names as seen (column names only, no data)
  rowsRead: number;
  members: ParsedMember[];       // unique, valid codes
  invalid: string[];             // offending code values (from the code column only, truncated)
  duplicates: number;            // extra occurrences of an already-seen code
  conflictingDuplicates: number; // codes whose duplicate rows disagreed on status (treated as inactive)
  irregularRecords: number;      // records whose line count was not one per column (e.g. wrapped text); located by code line
}

export class UmojaParseError extends Error {}

// Header names are compared loosely; a trailing footnote digit ("Employee Code2" in the real export) is ignored.
const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/[0-9]+$/, '');
const CODE_KEYS = new Set(['employeecode', 'empcode', 'employeeno', 'employeenumber']);
const STATUS_KEYS = new Set(['umojamembership', 'umojastatus', 'umojamember']);
/** Shape of an employee code (letters then digits). Deliberately looser than the validity check so bad codes still anchor a record. */
const LOOSE_CODE = /^[A-Za-z]{2,4}[0-9]{2,6}$/;
const separatedBlanks = (lines: string[]) => lines.length > 2 && lines[1] === '';
const OTHER_KEYS = new Set(['employeename', 'datejoined', 'activemonths', 'gender', 'position', 'businessunit']);

/** Minimal RFC-4180 reader (quoted fields, doubled quotes, newlines inside quotes). */
function readDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = ''; rows.push(row); row = [];
    } else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

function locate(columns: string[]): { codeIdx: number; statusIdx: number } {
  const codeIdx = columns.findIndex((c) => CODE_KEYS.has(key(c)));
  const statusIdx = columns.findIndex((c) => STATUS_KEYS.has(key(c)));
  if (codeIdx < 0 || statusIdx < 0) {
    throw new UmojaParseError(
      `Could not find the "Employee Code" and "Umoja Membership" columns. Columns seen: ${columns.map((c) => JSON.stringify(c)).join(', ')}`);
  }
  return { codeIdx, statusIdx };
}

class Collector {
  rowsRead = 0;
  invalid: string[] = [];
  duplicates = 0;
  conflicts = 0;
  irregular = 0;
  private seen = new Map<string, boolean>();
  add(rawCode: string, rawStatus: string): void {
    this.rowsRead++;
    const code = normalizeEmployeeCode(rawCode);
    if (!code) { this.invalid.push(rawCode.trim().slice(0, 16)); return; }
    const active = rawStatus.trim().toLowerCase() === 'active';
    const prev = this.seen.get(code);
    if (prev === undefined) { this.seen.set(code, active); return; }
    this.duplicates++;
    if (prev !== active) this.conflicts++;
    this.seen.set(code, prev && active);   // conflicting duplicates fail closed: inactive
  }
  members(): ParsedMember[] { return [...this.seen].map(([code, active]) => ({ code, active })); }
}

function finish(layout: 'csv' | 'lines', columns: string[], c: Collector): ParseResult {
  return {
    layout, columns, rowsRead: c.rowsRead, members: c.members(), invalid: c.invalid,
    duplicates: c.duplicates, conflictingDuplicates: c.conflicts, irregularRecords: c.irregular,
  };
}

export function parseUmojaExport(input: string): ParseResult {
  const text = input.replace(/^﻿/, '');
  const firstLine = text.split(/\r\n|\n|\r/).find((l) => l.trim() !== '');
  if (firstLine === undefined) throw new UmojaParseError('The file is empty');
  const delim = [',', '\t', ';'].find((d) => firstLine.includes(d));
  const col = new Collector();

  if (delim) {
    const rows = readDelimited(text, delim).filter((r) => r.some((f) => f.trim() !== ''));
    const columns = rows[0].map((c) => c.trim());
    const { codeIdx, statusIdx } = locate(columns);
    for (const r of rows.slice(1)) col.add(r[codeIdx] ?? '', r[statusIdx] ?? '');
    return finish('csv', columns, col);
  }

  // One value per line. The header is the leading run of lines that are known column names.
  const lines = text.split(/\r\n|\n|\r/).map((l) => l.trim());
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  while (lines.length && lines[0] === '') lines.shift();
  const known = (l: string) => CODE_KEYS.has(key(l)) || STATUS_KEYS.has(key(l)) || OTHER_KEYS.has(key(l));
  // Some exports put a blank line after EVERY value, header included: then blanks are separators, not empty values.
  if (lines.length > 2 && known(lines[0]) && lines[1] === '') { const kept = lines.filter((l) => l !== ''); lines.length = 0; lines.push(...kept); }
  let n = 0;
  while (n < lines.length && known(lines[n])) n++;
  if (n < 2) throw new UmojaParseError(`Could not read a header. First line seen: ${JSON.stringify((lines[0] ?? '').slice(0, 40))}`);
  const columns = lines.slice(0, n);
  const { codeIdx, statusIdx } = locate(columns);
  let body = lines.slice(n);
  if (body.length % n !== 0 && !separatedBlanks(lines)) body = body.filter((l) => l !== '');   // blanks may be separators rather than empty values
  const aligned = body.length % n === 0;
  if (aligned) {
    for (let i = 0; i < body.length; i += n) col.add(body[i + codeIdx], body[i + statusIdx]);
    return finish('lines', columns, col);
  }
  // Irregular export (e.g. a long position wrapped onto extra lines): anchor each record on its employee-code line.
  // Names, positions and units never look like a code, so they cannot start a record.
  body = body.filter((l) => l !== '');
  if (codeIdx !== 0 || !LOOSE_CODE.test(body[0] ?? '')) {
    throw new UmojaParseError(`${body.length} value lines do not divide into blocks of ${n} (one per column: ${columns.join(', ')})`);
  }
  const records: string[][] = [];
  for (const l of body) { if (LOOSE_CODE.test(l)) records.push([l]); else records[records.length - 1].push(l); }
  for (const r of records) {
    if (r.length !== n) col.irregular++;
    if (r.length <= statusIdx) col.invalid.push(r[0].slice(0, 16)); else col.add(r[0], r[statusIdx]);
  }
  return finish('lines', columns, col);
}
