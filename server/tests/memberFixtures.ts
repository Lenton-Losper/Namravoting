import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';

/** FAKE people only (obviously invented codes and example addresses). Never put a real member list in a test. */
export const HEADER = ['Employee Code', 'Display Name', 'Email Address'];
let n = 0;
const tmp = (ext: string) => path.join(os.tmpdir(), `members-test-${process.pid}-${++n}${ext}`);

export async function xlsxFile(rows: unknown[][], header: string[] | null = HEADER): Promise<string> {
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('Members');
  if (header) ws.addRow(header);
  for (const r of rows) ws.addRow(r);
  const f = tmp('.xlsx'); await wb.xlsx.writeFile(f); return f;
}
export function csvFile(rows: string[][], header: string[] | null = HEADER, delim = ','): string {
  const f = tmp('.csv');
  const q = (v: string) => (/[",\n;\t]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  fs.writeFileSync(f, '﻿' + [...(header ? [header] : []), ...rows].map((r) => r.map(q).join(delim)).join('\r\n') + '\r\n');
  return f;
}
export const cleanup = () => { for (const f of fs.readdirSync(os.tmpdir())) if (f.startsWith(`members-test-${process.pid}-`)) fs.rmSync(path.join(os.tmpdir(), f), { force: true }); };
