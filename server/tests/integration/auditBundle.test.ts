// Business-logic item 9: one downloadable bundle that shows the result AND how it was reached, and that anyone can verify.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { crc32, unzipStored, zip } from '../../src/services/zip.js';
import { ADMIN_A, ADMIN_B, S1, S2, S3, closeOwner, login, ownerDb, resetDb } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

type Admin = Awaited<ReturnType<typeof login>>;
const bin = (res: import('superagent').Response, cb: (e: Error | null, b: Buffer) => void) => { const k: Buffer[] = []; res.on('data', (d: Buffer) => k.push(d)); res.on('end', () => cb(null, Buffer.concat(k))); };

/** A closed campaign with a reset and an early close in its history. */
async function history(admin: Admin, opts: { close?: boolean } = {}) {
  const c = (await admin.post('/api/campaigns').send({ title: 'Leadership election', eligibility: 'all', closes_at: new Date(Date.now() + 3600_000).toISOString() }).expect(201)).body;
  const cands: string[] = [];
  for (const n of ['One', 'Two']) cands.push((await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', n).expect(201)).body.id);
  await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
  await (await login(app, S1)).post(`/api/vote/${c.share_token}`).send({ candidateId: cands[0] }).expect(201);
  await admin.post(`/api/campaigns/${c.id}/reset`).send({ confirm_title: 'Leadership election', reason: 'The wrong list was shown to voters' }).expect(200);
  await (await login(app, S1)).post(`/api/vote/${c.share_token}`).send({ candidateId: cands[0] }).expect(201);
  await (await login(app, S2)).post(`/api/vote/${c.share_token}`).send({ candidateId: cands[1] }).expect(201);
  await (await login(app, S3)).post(`/api/vote/${c.share_token}`).send({ candidateId: cands[0] }).expect(201);
  if (opts.close !== false) await admin.post(`/api/campaigns/${c.id}/close`).send({ reason: 'Everyone has voted, closing early' }).expect(200);
  return { id: c.id as string, token: c.share_token as string };
}
const download = async (s: Admin, url: string) => (await s.get(url).buffer(true).parse(bin).expect(200)).body as Buffer;
const files = (zipBuf: Buffer) => Object.fromEntries(unzipStored(zipBuf).map((e) => [e.name, e.data]));

describe('the zip writer', () => {
  it('round-trips files byte for byte with UTF-8 names, and detects damage', () => {
    const a = Buffer.from('hello world'); const b = Buffer.from([0, 255, 1, 2, 3]);
    const z = zip([{ name: 'a.txt', data: a }, { name: 'dir/Übung.bin', data: b }, { name: 'empty', data: Buffer.alloc(0) }]);
    expect(unzipStored(z).map((e) => [e.name, e.data.length])).toEqual([['a.txt', 11], ['dir/Übung.bin', 5], ['empty', 0]]);
    expect(unzipStored(z)[1].data.equals(b)).toBe(true);
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);                           // the standard CRC-32 check value
    const bad = Buffer.from(z); bad[40] ^= 0xff;
    expect(() => unzipStored(bad)).toThrow(/checksum|central/);
  });
});

describe('GET /api/campaigns/:id/audit-bundle.zip', () => {
  it('holds the result in three formats, the audit log, a verification script and a README that states the record\'s condition', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await history(admin);
    const f = files(await download(admin, `/api/campaigns/${c.id}/audit-bundle.zip`));
    expect(Object.keys(f)).toEqual(['README.txt', 'results.pdf', 'results.xlsx', 'results.csv', 'audit-log.csv', 'verify-audit.mjs']);
    expect(f['results.pdf'].subarray(0, 5).toString()).toBe('%PDF-'); expect(f['results.xlsx'].subarray(0, 2).toString()).toBe('PK');
    expect(f['results.csv'].toString()).toBe((await admin.get(`/api/campaigns/${c.id}/results.csv`).expect(200)).text);     // the same CSV as the download
    const seal = (await ownerDb().query("SELECT hash, seq FROM audit_log WHERE campaign_id = $1 AND action LIKE 'campaign.close%' ORDER BY seq DESC LIMIT 1", [c.id])).rows[0];
    const readme = f['README.txt'].toString();
    expect(readme).toContain('Campaign: Leadership election');
    expect(readme).toContain(`Seal fingerprint:                     ${seal.hash}`);
    expect(readme).toContain('Audit chain of the whole system:      INTACT');
    expect(readme).toContain('Counters equal the sealed tallies:    yes');
    expect(readme).toContain('Turnout:                              3');
    expect(readme).toContain(`entry ${seal.seq}`);
    expect(readme).toContain('Who voted, and for whom');
    expect(f['results.csv'].toString()).toContain(`Seal fingerprint,${seal.hash}`);
  });

  it('the audit log lists every entry of the campaign (including the reset and the early close, with their reasons) with the hashes', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await history(admin);
    const csv = files(await download(admin, `/api/campaigns/${c.id}/audit-bundle.zip`))['audit-log.csv'].toString();
    const dbRows = (await ownerDb().query("SELECT action FROM audit_log WHERE campaign_id = $1 AND action <> 'results.export_bundle' ORDER BY seq", [c.id])).rows.map((r) => r.action as string);
    const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
    expect(lines[0]).toBe('seq,id,at_utc,at_windhoek,actor_oid,actor,action,campaign_id,details,prev_hash,hash');
    expect(lines.length - 1).toBe(dbRows.length);                                        // the entry for this download itself is written after the file is built
    expect(csv).toContain('campaign.reset'); expect(csv).toContain('The wrong list was shown to voters');
    expect(csv).toContain('Everyone has voted, closing early');
    expect(csv).toContain(ADMIN_A.displayName);
  });

  it('contains nothing that says who voted: no voter email, no voter account id', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await history(admin);
    const f = files(await download(admin, `/api/campaigns/${c.id}/audit-bundle.zip`));
    const text = ['README.txt', 'results.csv', 'audit-log.csv'].map((n) => f[n].toString()).join('\n');
    for (const v of [S1, S2, S3]) { expect(text).not.toContain(v.email); expect(text).not.toContain(v.oid); expect(text).not.toContain(v.displayName); }
  });

  it('verify-audit.mjs confirms the entries as exported, and catches a changed one', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await history(admin);
    const f = files(await download(admin, `/api/campaigns/${c.id}/audit-bundle.zip`));
    const dir = mkdtempSync(path.join(os.tmpdir(), 'bundle-'));
    try {
      writeFileSync(path.join(dir, 'verify-audit.mjs'), f['verify-audit.mjs']); writeFileSync(path.join(dir, 'audit-log.csv'), f['audit-log.csv']);
      const run = () => spawnSync(process.execPath, ['verify-audit.mjs', 'audit-log.csv'], { cwd: dir, encoding: 'utf8' });
      const ok = run();
      expect(ok.status).toBe(0); expect(ok.stdout).toMatch(/\d+ entries checked, 0 do not match\./);
      writeFileSync(path.join(dir, 'audit-log.csv'), f['audit-log.csv'].toString().replace('The wrong list was shown to voters', 'Nothing was wrong at all, really'));
      const bad = run();
      expect(bad.status).toBe(1); expect(bad.stdout).toContain('MISMATCH at entry'); expect(bad.stdout).toContain('campaign.reset');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('only for a closed campaign; only the creator or a co-admin; audited; and it counts as the copy needed before a permanent delete', async () => {
    const admin = await login(app, ADMIN_A); const other = await login(app, ADMIN_B); const staff = await login(app, S1);
    const open = await history(admin, { close: false });
    expect((await admin.get(`/api/campaigns/${open.id}/audit-bundle.zip`).expect(409)).body.code).toBe('not_closed');
    await admin.post(`/api/campaigns/${open.id}/close`).send({ reason: 'Closing it now for the test' }).expect(200);
    await other.get(`/api/campaigns/${open.id}/audit-bundle.zip`).expect(404);
    await staff.get(`/api/campaigns/${open.id}/audit-bundle.zip`).expect(403);
    await (await import('supertest')).default(app).get(`/api/campaigns/${open.id}/audit-bundle.zip`).expect(401);
    await admin.post(`/api/campaigns/${open.id}/team`).send({ email: ADMIN_B.email, role: 'co_admin' }).expect(201);
    await other.get(`/api/campaigns/${open.id}/audit-bundle.zip`).expect(200);
    expect((await ownerDb().query("SELECT count(*)::int AS n FROM audit_log WHERE campaign_id = $1 AND action = 'results.export_bundle'", [open.id])).rows[0].n).toBe(1);
    await admin.post(`/api/campaigns/${open.id}/archive`).expect(200);
    await admin.post(`/api/campaigns/${open.id}/permanent-delete`).send({ confirm_title: 'Leadership election' }).expect(200);          // the co-admin's bundle is the copy the rule asks for
  });

  it('the bundle alone satisfies the "export before deleting" rule', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await history(admin);
    await admin.post(`/api/campaigns/${c.id}/archive`).expect(200);
    expect((await admin.post(`/api/campaigns/${c.id}/permanent-delete`).send({ confirm_title: 'Leadership election' }).expect(409)).body.code).toBe('export_first');
    await download(admin, `/api/campaigns/${c.id}/audit-bundle.zip`);
    await admin.post(`/api/campaigns/${c.id}/permanent-delete`).send({ confirm_title: 'Leadership election' }).expect(200);
  });
});

describe('observers', () => {
  it('can download the same bundle for a closed campaign, only if they observe it', async () => {
    const admin = await login(app, ADMIN_A); const obs = await login(app, S1); const stranger = await login(app, S2);
    const c = await history(admin);
    await admin.post(`/api/campaigns/${c.id}/team`).send({ email: S1.email, role: 'observer' }).expect(201);
    const f = files(await download(obs, `/api/observe/${c.id}/audit-bundle.zip`));
    expect(Object.keys(f)).toContain('audit-log.csv');
    expect(f['README.txt'].toString()).toContain(`${S1.displayName} (observer)`);
    await stranger.get(`/api/observe/${c.id}/audit-bundle.zip`).expect(404);
    const open = await history(admin, { close: false });
    await admin.post(`/api/campaigns/${open.id}/team`).send({ email: S1.email, role: 'observer' }).expect(201);
    expect((await obs.get(`/api/observe/${open.id}/audit-bundle.zip`).expect(409)).body.code).toBe('not_closed');
  });
});
