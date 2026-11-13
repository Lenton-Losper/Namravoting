// Business-logic item 5: retention. Old archived campaigns lose their personal data but keep the sealed result; leavers are anonymised.
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { anonymiseUsers, findPurgeable, purgeCampaign } from '../../src/services/retention.js';
import { ADMIN_A, S1, S2, S3, TEST_APP_URL, closeOwner, login, ownerDb, png, resetDb } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); await appRole.end(); });
const appRole = new pg.Pool({ connectionString: TEST_APP_URL, max: 1 });

type Admin = Awaited<ReturnType<typeof login>>;

/** A closed campaign (list eligibility, 2 photos, 3 votes), exported; archived when asked. */
async function campaign(admin: Admin, opts: { archive?: boolean; close?: boolean } = {}) {
  const c = (await admin.post('/api/campaigns').send({ title: 'Old vote', eligibility: 'list', emails: [S1.email, S2.email, S3.email] }).expect(201)).body;
  const cands: string[] = [];
  for (const n of ['One', 'Two']) cands.push((await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', n).attach('photo', await png(), { filename: 'p.png', contentType: 'image/png' }).expect(201)).body.id);
  await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
  await (await login(app, S1)).post(`/api/vote/${c.share_token}`).send({ candidateId: cands[0] }).expect(201);
  await (await login(app, S2)).post(`/api/vote/${c.share_token}`).send({ candidateId: cands[0] }).expect(201);
  await (await login(app, S3)).post(`/api/vote/${c.share_token}`).send({ candidateId: cands[1] }).expect(201);
  if (opts.close !== false) {
    await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
    await admin.get(`/api/campaigns/${c.id}/results.csv`).expect(200);
    if (opts.archive !== false) await admin.post(`/api/campaigns/${c.id}/archive`).expect(200);
  }
  return { id: c.id as string, token: c.share_token as string, cands };
}
const count = async (sql: string, p: unknown[]) => (await ownerDb().query(sql, p)).rows[0].n as number;

describe('which campaigns are due', () => {
  it('only closed AND archived ones, and only after the period', async () => {
    const admin = await login(app, ADMIN_A);
    const open = await campaign(admin, { close: false });
    const closedOnly = await campaign(admin, { archive: false });
    const archived = await campaign(admin);
    const due0 = (await findPurgeable(ownerDb(), 0)).map((x) => x.id);
    expect(due0).toEqual([archived.id]);
    expect(due0).not.toContain(open.id); expect(due0).not.toContain(closedOnly.id);
    expect(await findPurgeable(ownerDb(), 24)).toEqual([]);                    // closed a moment ago: nowhere near 24 months
    expect((await findPurgeable(ownerDb(), 0))[0]).toMatchObject({ title: 'Old vote', receipts: 3 });
  });
});

describe('purging a campaign', () => {
  it('removes receipts, the voter list, the snapshot and the photos, and keeps the sealed result and the audit chain', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await campaign(admin);
    const photos = (await ownerDb().query('SELECT photo_path FROM candidates WHERE campaign_id = $1', [c.id])).rows.map((r) => r.photo_path as string);
    expect(photos).toHaveLength(2);
    const deleted: string[] = [];
    const r = await purgeCampaign(ownerDb(), c.id, async (n) => { deleted.push(n); });
    expect(r).toMatchObject({ receipts: 3, eligible_voters: 3, photos: 2 });
    expect(deleted.sort()).toEqual(photos.sort());
    expect(await count('SELECT count(*)::int AS n FROM vote_receipts WHERE campaign_id = $1', [c.id])).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM eligible_voters WHERE campaign_id = $1', [c.id])).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM campaign_voters WHERE campaign_id = $1', [c.id])).toBe(0);
    // the result survives: counters, results, CSV, and the seal still verifies (receipts are "not applicable" now)
    const results = (await admin.get(`/api/campaigns/${c.id}/results`).expect(200)).body;
    expect(results.candidates.map((x: { votes: number }) => x.votes)).toEqual([2, 1]);
    expect((await admin.get(`/api/campaigns/${c.id}/verify`).expect(200)).body).toMatchObject({ chain_ok: true, sealed: true, tallies_match: true, receipts_match: null });
    await admin.get(`/api/campaigns/${c.id}/results.csv`).expect(200);
    expect((await ownerDb().query('SELECT audit_chain_verify() AS r')).rows[0].r).toMatchObject({ ok: true });
    const a = (await ownerDb().query("SELECT actor_oid, details FROM audit_log WHERE campaign_id = $1 AND action = 'retention.purged'", [c.id])).rows;
    expect(a).toHaveLength(1); expect(a[0].actor_oid).toBeNull(); expect(a[0].details).toMatchObject({ receipts_removed: 3, photos_removed: 2 });
    const detail = (await admin.get(`/api/campaigns/${c.id}`).expect(200)).body;
    expect(detail.receipts_purged_at).toBeTruthy(); expect(detail.candidates.every((x: { photo_url: string | null }) => x.photo_url === null)).toBe(true);
  });

  it('is done once: a second run finds nothing, and a purged campaign cannot be reset', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await campaign(admin);
    await purgeCampaign(ownerDb(), c.id, async () => undefined);
    expect(await purgeCampaign(ownerDb(), c.id, async () => undefined)).toBeNull();
    expect(await findPurgeable(ownerDb(), 0)).toEqual([]);
    await admin.post(`/api/campaigns/${c.id}/unarchive`).expect(200);
    expect((await admin.post(`/api/campaigns/${c.id}/reset`).send({ confirm_title: 'Old vote', reason: 'Trying to start again' }).expect(409)).body.code).toBe('purged');
  });

  it('refuses a campaign that is open, or closed but not archived', async () => {
    const admin = await login(app, ADMIN_A);
    const open = await campaign(admin, { close: false });
    const closedOnly = await campaign(admin, { archive: false });
    expect(await purgeCampaign(ownerDb(), open.id, async () => undefined)).toBeNull();
    expect(await purgeCampaign(ownerDb(), closedOnly.id, async () => undefined)).toBeNull();
    expect(await count('SELECT count(*)::int AS n FROM vote_receipts WHERE campaign_id = $1', [open.id])).toBe(3);
  });

  it('the app role cannot mark a campaign as purged (only the retention job can)', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await campaign(admin);
    await expect(appRole.query('UPDATE campaigns SET receipts_purged_at = now() WHERE id = $1', [c.id])).rejects.toThrow(/retention job/);
    await expect(appRole.query('DELETE FROM vote_receipts WHERE campaign_id = $1', [c.id])).rejects.toThrow(/permission denied/);   // and it still cannot delete receipts itself
  });

  it('a failing file delete does not undo the purge', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await campaign(admin);
    const r = await purgeCampaign(ownerDb(), c.id, async () => { throw new Error('storage down'); });
    expect(r?.receipts).toBe(3);
    expect(await count('SELECT count(*)::int AS n FROM vote_receipts WHERE campaign_id = $1', [c.id])).toBe(0);
  });
});

describe('people who have left', () => {
  it('replaces name, email and employee code, ends sessions, and keeps the account id so the audit trail still reads', async () => {
    const admin = await login(app, ADMIN_A);
    await login(app, S1);
    await ownerDb().query("UPDATE users SET employee_code = 'TST0445' WHERE entra_oid = $1", [S1.oid]);
    await ownerDb().query('INSERT INTO eligible_voters (campaign_id, voter_email) SELECT id, $1 FROM campaigns', [S1.email]);
    const c = await campaign(admin, { close: false });
    await ownerDb().query('INSERT INTO eligible_voters (campaign_id, voter_email) VALUES ($1, $2) ON CONFLICT DO NOTHING', [c.id, S1.email]);
    const dry = await anonymiseUsers(ownerDb(), [S1.email], false);
    expect(dry).toEqual([expect.objectContaining({ outcome: 'anonymised' })]);
    expect((await ownerDb().query('SELECT display_name FROM users WHERE entra_oid = $1', [S1.oid])).rows[0].display_name).toBe(S1.displayName);   // dry run changed nothing
    const res = await anonymiseUsers(ownerDb(), [S1.email, 'nobody@nowhere.test', ''], true);
    expect(res.map((x) => x.outcome)).toEqual(['anonymised', 'not_found']);
    expect(JSON.stringify(res)).not.toContain(S1.email);                                   // reports never echo the address
    const u = (await ownerDb().query('SELECT email, display_name, employee_code FROM users WHERE entra_oid = $1', [S1.oid])).rows[0];
    expect(u).toEqual({ email: `removed-${S1.oid}@removed.invalid`, display_name: 'Former staff member', employee_code: null });
    expect(await count('SELECT count(*)::int AS n FROM sessions WHERE user_oid = $1', [S1.oid])).toBe(0);
    expect(await count('SELECT count(*)::int AS n FROM eligible_voters WHERE voter_email = $1', [S1.email])).toBe(0);
    expect(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'retention.user_anonymised' AND details->>'user' = $1", [S1.oid])).toBe(1);
    expect((await anonymiseUsers(ownerDb(), [u.email], true))[0].outcome).toBe('already_anonymised');   // idempotent
    expect((await anonymiseUsers(ownerDb(), [S1.email], true))[0].outcome).toBe('not_found');           // the old address no longer exists
    expect(await count("SELECT count(*)::int AS n FROM audit_log WHERE action = 'retention.user_anonymised'", [])).toBe(1);
  });

  it('does not remove someone who still runs a draft or open campaign', async () => {
    const admin = await login(app, ADMIN_A);
    await campaign(admin, { close: false });
    const res = await anonymiseUsers(ownerDb(), [ADMIN_A.email], true);
    expect(res[0].outcome).toBe('owns_active_campaigns');
    expect((await ownerDb().query('SELECT display_name FROM users WHERE entra_oid = $1', [ADMIN_A.oid])).rows[0].display_name).toBe(ADMIN_A.displayName);
  });
});
