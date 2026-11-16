// Seals written before migration 009 recorded only totals ({ match, reason, ballots, receipts }), not each candidate's counter.
// Such a seal is checked against its totals, so an old campaign verifies, publishes and exports; a changed counter is still caught.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { sealedCountersMatch } from '../../src/services/campaigns.js';
import { checkDatabase } from '../../src/services/restoreCheck.js';
import { ADMIN_A, S1, S2, closeOwner, login, makeCampaign, ownerDb, resetDb } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

/** A campaign closed the way the app did before migration 009: status closed, and a close entry with totals only. */
async function oldStyleClosed() {
  const admin = await login(app, ADMIN_A);
  const c = await makeCampaign(admin, 2, 'test campaign');
  await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
  await (await login(app, S1)).post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
  await (await login(app, S2)).post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
  await ownerDb().query("UPDATE campaigns SET status = 'closed' WHERE id = $1", [c.id]);
  await ownerDb().query("INSERT INTO audit_log (actor_oid, action, campaign_id, details) VALUES ($1, 'campaign.close', $2, $3)",
    [ADMIN_A.oid, c.id, JSON.stringify({ match: true, reason: 'manual', ballots: 2, receipts: 2 })]);
  return { admin, ...c };
}
const sealCheck = async (db: ReturnType<typeof ownerDb>) => (await checkDatabase(db)).checks.find((x) => x.name === 'Sealed results equal the counters')!;

describe('a totals-only seal from before migration 009', () => {
  it('verifies against its totals, and says it is a totals-only seal', async () => {
    const c = await oldStyleClosed();
    const v = (await c.admin.get(`/api/campaigns/${c.id}/verify`).expect(200)).body;
    expect(v).toMatchObject({ chain_ok: true, sealed: true, tallies_match: true, receipts_match: true, sealed_turnout: 2, legacy_totals_only: true });
    expect(v.sealed_tallies).toEqual([]);
  });

  it('can be announced and exported (CSV, Excel, PDF, audit bundle), and the restore check passes', async () => {
    const c = await oldStyleClosed();
    await c.admin.post(`/api/campaigns/${c.id}/announce-winners`).expect(201);
    for (const f of ['results.csv', 'results.xlsx', 'results.pdf', 'audit-bundle.zip']) await c.admin.get(`/api/campaigns/${c.id}/${f}`).expect(200);
    expect((await c.admin.get(`/api/campaigns/${c.id}/results.csv`).expect(200)).text).toContain('Seal fingerprint,');
    expect(await sealCheck(ownerDb())).toMatchObject({ ok: true, detail: 'every closed campaign' });
  });

  it('still catches a changed counter: verify fails, announcing is refused, and the restore check fails', async () => {
    const c = await oldStyleClosed();
    await ownerDb().query('UPDATE tallies SET votes = votes + 1 WHERE candidate_id = $1', [c.candidates[1]]);
    const v = (await c.admin.get(`/api/campaigns/${c.id}/verify`).expect(200)).body;
    expect(v.tallies_match).toBe(false);
    expect((await c.admin.post(`/api/campaigns/${c.id}/announce-winners`).expect(409)).body.code).toBe('integrity_failed');
    expect((await sealCheck(ownerDb())).ok).toBe(false);
  });

  it('a seal with neither tallies nor totals cannot be trusted', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2, 'No totals');
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    await ownerDb().query("UPDATE campaigns SET status = 'closed' WHERE id = $1", [c.id]);
    await ownerDb().query("INSERT INTO audit_log (actor_oid, action, campaign_id, details) VALUES (NULL, 'campaign.close', $1, '{\"reason\":\"auto\"}')", [c.id]);
    expect((await admin.get(`/api/campaigns/${c.id}/verify`).expect(200)).body.tallies_match).toBe(false);
  });

  it('a seal written today (with tallies) is still compared candidate by candidate', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2, 'New style');
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    await (await login(app, S1)).post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
    await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
    expect((await admin.get(`/api/campaigns/${c.id}/verify`).expect(200)).body).toMatchObject({ tallies_match: true, receipts_match: true });
    expect((await admin.get(`/api/campaigns/${c.id}/verify`)).body.legacy_totals_only).toBeUndefined();
    // moving a vote between candidates keeps the total but is caught, because this seal has the per-candidate counts
    await ownerDb().query('UPDATE tallies SET votes = votes - 1 WHERE candidate_id = $1', [c.candidates[0]]);
    await ownerDb().query('UPDATE tallies SET votes = votes + 1 WHERE candidate_id = $1', [c.candidates[1]]);
    expect((await admin.get(`/api/campaigns/${c.id}/verify`)).body.tallies_match).toBe(false);
  });
});

describe('sealedCountersMatch', () => {
  const now = [{ candidate_id: 'a', votes: 1 }, { candidate_id: 'b', votes: 0 }];
  it('totals-only seals compare the sum of the counters with the sealed ballots', () => {
    expect(sealedCountersMatch({ match: true, reason: 'manual', ballots: 1, receipts: 1 }, now)).toEqual({ match: true, legacy: true });
    expect(sealedCountersMatch({ ballots: 2, receipts: 2 }, now)).toEqual({ match: false, legacy: true });
    expect(sealedCountersMatch({ reason: 'auto' }, now)).toEqual({ match: false, legacy: true });
    expect(sealedCountersMatch({ ballots: 0 }, [])).toEqual({ match: null, legacy: true });
  });
  it('seals with tallies compare candidate by candidate', () => {
    expect(sealedCountersMatch({ tallies: [{ candidate_id: 'a', votes: 1 }, { candidate_id: 'b', votes: 0 }] }, now)).toEqual({ match: true, legacy: false });
    expect(sealedCountersMatch({ tallies: [{ candidate_id: 'a', votes: 0 }, { candidate_id: 'b', votes: 1 }] }, now)).toEqual({ match: false, legacy: false });
    expect(sealedCountersMatch({ tallies: [] }, now)).toEqual({ match: false, legacy: false });
  });
});
