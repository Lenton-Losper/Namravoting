// Business-logic item 6: a copy of every sealed result outside the database, and a check that a restored database is trustworthy.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool, getPool } from '../../src/db.js';
import { backupSealedResult, buildSealedBackup } from '../../src/services/backup.js';
import { checkDatabase, formatReport } from '../../src/services/restoreCheck.js';
import { createDiskStorage, getStorage, type PhotoStorage } from '../../src/services/storage.js';
import { ADMIN_A, S1, S2, closeOwner, login, ownerDb, resetDb } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

type Admin = Awaited<ReturnType<typeof login>>;
async function campaign(admin: Admin, close = true) {
  const c = (await admin.post('/api/campaigns').send({ title: 'Backed up', eligibility: 'all' }).expect(201)).body;
  const cands: string[] = [];
  for (const n of ['One', 'Two']) cands.push((await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', n).expect(201)).body.id);
  await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
  await (await login(app, S1)).post(`/api/vote/${c.share_token}`).send({ candidateId: cands[0] }).expect(201);
  await (await login(app, S2)).post(`/api/vote/${c.share_token}`).send({ candidateId: cands[0] }).expect(201);
  if (close) await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
  return { id: c.id as string, token: c.share_token as string, cands };
}
const sealSeq = async (id: string) => Number((await ownerDb().query("SELECT seq FROM audit_log WHERE campaign_id = $1 AND action LIKE 'campaign.close%' ORDER BY seq DESC LIMIT 1", [id])).rows[0].seq);

describe('the sealed-result copy', () => {
  it('is written when a campaign closes, holds the result and the fingerprint, and no personal data', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await campaign(admin);
    const seq = await sealSeq(c.id);
    const raw = await getStorage().get(`sealed-${c.id}-${seq}.json`);
    expect(raw).not.toBeNull();
    const doc = JSON.parse(raw!.toString('utf8'));
    const fingerprint = (await ownerDb().query('SELECT hash FROM audit_log WHERE campaign_id = $1 AND seq = $2', [c.id, seq])).rows[0].hash;
    expect(doc).toMatchObject({ format: 1, campaign: { id: c.id, title: 'Backed up' }, sealed: { audit_seq: seq, fingerprint }, turnout: { votes: 2 } });
    expect(doc.tallies).toEqual([{ position: 'Backed up', name: 'One', votes: 2 }, { position: 'Backed up', name: 'Two', votes: 0 }]);
    expect(doc.positions).toHaveLength(1);
    expect(doc.positions[0]).toMatchObject({ title: 'Backed up', turnout: 2, winners: ['One'] });
    const text = raw!.toString('utf8');
    for (const personal of [S1.email, S2.email, ADMIN_A.email, S1.oid, S2.oid, ADMIN_A.oid, S1.displayName]) expect(text).not.toContain(personal);
    const a = (await ownerDb().query("SELECT details FROM audit_log WHERE campaign_id = $1 AND action = 'result.backed_up'", [c.id])).rows;
    expect(a).toHaveLength(1); expect(a[0].details.key).toBe(`sealed-${c.id}-${seq}.json`); expect(a[0].details.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is also written when the closing time passes (automatic close)', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await campaign(admin, false);
    await ownerDb().query("UPDATE campaigns SET closes_at = now() - interval '1 minute' WHERE id = $1", [c.id]);
    await admin.get(`/api/campaigns/${c.id}`).expect(200);                       // any look at the campaign closes it
    expect((await ownerDb().query('SELECT status FROM campaigns WHERE id = $1', [c.id])).rows[0].status).toBe('closed');
    expect(await getStorage().get(`sealed-${c.id}-${await sealSeq(c.id)}.json`)).not.toBeNull();
  });

  it('a reset and a second close make a second copy; the first stays', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await campaign(admin);
    const first = await sealSeq(c.id);
    await admin.post(`/api/campaigns/${c.id}/reset`).send({ confirm_title: 'Backed up', reason: 'Counting again from scratch' }).expect(200);
    await (await login(app, S1)).post(`/api/vote/${c.token}`).send({ candidateId: c.cands[1] }).expect(201);
    await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
    const second = await sealSeq(c.id);
    expect(second).toBeGreaterThan(first);
    const old = JSON.parse((await getStorage().get(`sealed-${c.id}-${first}.json`))!.toString());
    const now = JSON.parse((await getStorage().get(`sealed-${c.id}-${second}.json`))!.toString());
    expect(old.turnout.votes).toBe(2); expect(now.turnout.votes).toBe(1);
  });

  it('is not written for a campaign that is not closed', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await campaign(admin, false);
    expect(await buildSealedBackup(getPool(), c.id)).toBeNull();
    expect(await backupSealedResult(c.id)).toBe(false);
  });

  it('a storage failure never undoes or blocks the close: it is recorded as result.backup_failed', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await campaign(admin);
    const broken: PhotoStorage = { put: async () => { throw new Error('bucket unreachable'); }, get: async () => null, delete: async () => undefined };
    expect(await backupSealedResult(c.id, broken)).toBe(false);
    expect((await ownerDb().query('SELECT status FROM campaigns WHERE id = $1', [c.id])).rows[0].status).toBe('closed');
    const f = (await ownerDb().query("SELECT details FROM audit_log WHERE campaign_id = $1 AND action = 'result.backup_failed'", [c.id])).rows;
    expect(f).toHaveLength(1); expect(f[0].details.error).toContain('bucket unreachable');
  });
});

describe('checking a restored database', () => {
  it('a healthy database passes', async () => {
    const admin = await login(app, ADMIN_A);
    await campaign(admin);
    const r = await checkDatabase(ownerDb(), getStorage());
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => [c.name, c.ok])).toEqual([['Migrations', true], ['Audit chain', true], ['Receipts equal counters', true], ['Closed campaigns are sealed', true],
      ['Sealed results equal the counters', true], ['Sealed-result copies in storage', true]]);
    expect(r.counts).toMatchObject({ campaigns: 1, closed_campaigns: 1 });
    expect(formatReport(r)).toContain('RESULT: this database is a faithful copy.');
  });

  it('fails when a counter was changed after the seal, or receipts and counters disagree', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await campaign(admin);
    await ownerDb().query('UPDATE tallies SET votes = votes + 1 WHERE campaign_id = $1 AND candidate_id = $2', [c.id, c.cands[1]]);
    const r = await checkDatabase(ownerDb());
    expect(r.ok).toBe(false);
    expect(r.checks.filter((x) => !x.ok).map((x) => x.name)).toEqual(['Receipts equal counters', 'Sealed results equal the counters']);
    expect(formatReport(r)).toContain('DO NOT USE this database');
  });

  it('fails when the audit chain is broken', async () => {
    const admin = await login(app, ADMIN_A);
    await campaign(admin);
    await ownerDb().query("ALTER TABLE audit_log DISABLE TRIGGER USER");
    try { await ownerDb().query("UPDATE audit_log SET action = 'campaign.tampered' WHERE seq = 2"); } finally { await ownerDb().query('ALTER TABLE audit_log ENABLE TRIGGER USER'); }
    const r = await checkDatabase(ownerDb());
    expect(r.ok).toBe(false);
    expect(r.checks.find((x) => x.name === 'Audit chain')).toMatchObject({ ok: false });
  });

  it('a closed campaign with no copy in storage is a warning, not a failure, and says how to fix it', async () => {
    const admin = await login(app, ADMIN_A);
    await campaign(admin);
    const empty = createDiskStorage('/nonexistent-dir-for-test');
    const r = await checkDatabase(ownerDb(), empty);
    expect(r.ok).toBe(true);
    const w = r.checks.find((x) => x.name === 'Sealed-result copies in storage')!;
    expect(w).toMatchObject({ ok: false, warn: true }); expect(w.detail).toContain('npm run backup:sealed');
    expect(formatReport(r)).toContain('WARN');
  });

  it('a campaign purged by the retention job is not reported as a receipts mismatch', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await campaign(admin);
    await admin.post(`/api/campaigns/${c.id}/archive`).expect(200);
    const { purgeCampaign } = await import('../../src/services/retention.js');
    await purgeCampaign(ownerDb(), c.id, async () => undefined);
    expect((await checkDatabase(ownerDb())).ok).toBe(true);
  });
});
