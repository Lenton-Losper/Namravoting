import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { normalizeEmployeeCode } from '../domain/employeeCode.js';
import { NAMRA_DOMAIN, isEmailAddress } from '../domain/eligibility.js';
import { readDelimited } from './parse.js';

/**
 * The member list the DBA loads: an .xlsx or .csv with the columns "Employee Code", "Display Name" and "Email Address".
 *
 * PRIVACY: the display name is read so the file can be recognised as the right one, and is then dropped; it is never stored, returned,
 * printed or audited. Rejected rows are reported by ROW NUMBER and reason only, never by their content.
 */
export interface MemberRow { row: number; code: string; email: string }
export interface RejectedRow { row: number; reason: string }
export interface MemberFile {
  /** Spreadsheet rows read after the header. */
  rowsRead: number;
  members: MemberRow[];
  rejected: RejectedRow[];
  /** Repeats of a row that is already in the file with the same code AND email: harmless, counted, not rejected. */
  duplicates: number;
  /** SHA-256 of the file's bytes: recorded in the audit entry so the exact list that was loaded can be identified later. */
  sha256: string;
}

export class MemberFileError extends Error {}

const key = (h: unknown) => String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const CODE = new Set(['employeecode', 'empcode']);
const NAME = new Set(['displayname', 'name', 'employeename']);
const MAIL = new Set(['emailaddress', 'email', 'mail']);

/** A cell as text: plain values, hyperlinks ({ text, hyperlink }), formulas ({ result }) and rich text all become the text a person sees. */
function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return '';
    const o = v as unknown as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text: string }[]).map((t) => t.text).join('');
    if (o.text !== undefined) return cellText(o.text as ExcelJS.CellValue);
    if (o.result !== undefined) return cellText(o.result as ExcelJS.CellValue);
    if (typeof o.hyperlink === 'string') return o.hyperlink.replace(/^mailto:/i, '');
    return '';
  }
  return String(v);
}

async function readRows(file: string, bytes: Buffer): Promise<string[][]> {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.xlsx') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer);
    const ws = wb.worksheets[0];
    if (!ws) throw new MemberFileError('The workbook has no sheets');
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: true }, (r, n) => { const cells: string[] = []; r.eachCell({ includeEmpty: true }, (c, col) => { cells[col - 1] = cellText(c.value); }); rows[n - 1] = cells; });
    for (let i = 0; i < rows.length; i++) rows[i] ??= [];
    return rows;
  }
  if (ext === '.csv') {
    const text = bytes.toString('utf8').replace(/^﻿/, '');
    const first = text.split(/\r?\n/, 1)[0] ?? '';
    const delim = first.includes('\t') ? '\t' : (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : ',';
    return readDelimited(text, delim);
  }
  throw new MemberFileError('The file must be an .xlsx or a .csv');
}

export async function parseMemberFile(file: string): Promise<MemberFile> {
  let bytes: Buffer;
  try { bytes = fs.readFileSync(file); } catch (e) { throw new MemberFileError(`Cannot read the file: ${(e as NodeJS.ErrnoException).code ?? 'error'}`); }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const rows = await readRows(file, bytes);

  const headerAt = rows.findIndex((r) => r.some((c) => CODE.has(key(c))));
  if (headerAt < 0) throw new MemberFileError('Could not find the header row: the columns must be "Employee Code", "Display Name" and "Email Address"');
  const head = rows[headerAt];
  const codeIdx = head.findIndex((c) => CODE.has(key(c))), nameIdx = head.findIndex((c) => NAME.has(key(c))), mailIdx = head.findIndex((c) => MAIL.has(key(c)));
  const missing = [codeIdx < 0 && 'Employee Code', nameIdx < 0 && 'Display Name', mailIdx < 0 && 'Email Address'].filter(Boolean);
  if (missing.length) throw new MemberFileError(`Missing column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}`);

  const members: MemberRow[] = []; const rejected: RejectedRow[] = []; let duplicates = 0; let rowsRead = 0;
  const byCode = new Map<string, string>(); const byEmail = new Map<string, string>();
  for (let i = headerAt + 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    if (r.every((c) => !String(c ?? '').trim())) continue;   // a blank line is not a row
    rowsRead++;
    const row = i + 1;                                         // the number the spreadsheet shows
    const code = normalizeEmployeeCode(String(r[codeIdx] ?? ''));
    if (!code) { rejected.push({ row, reason: 'invalid employee code' }); continue; }
    const email = String(r[mailIdx] ?? '').trim().toLowerCase();
    if (!isEmailAddress(email)) { rejected.push({ row, reason: 'invalid email address' }); continue; }
    if (!email.endsWith('@' + NAMRA_DOMAIN)) { rejected.push({ row, reason: `email is not @${NAMRA_DOMAIN}` }); continue; }
    if (byCode.has(code)) {
      if (byCode.get(code) === email) duplicates++; else rejected.push({ row, reason: 'employee code appears earlier with a different email' });
      continue;
    }
    if (byEmail.has(email)) { rejected.push({ row, reason: 'email address is already used by another employee code' }); continue; }
    byCode.set(code, email); byEmail.set(email, code);
    members.push({ row, code, email });
  }
  return { rowsRead, members, rejected, duplicates, sha256 };
}
