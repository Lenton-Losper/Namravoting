import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { ADMIN_A, S1, S2, S3, closeOwner, count, login, makeCampaign, ownerDb, resetDb, setMembers } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

const REASON = 'Ballot printed with a wrong name, voting again';
const future = () => new Date(Date.now() + 3600_000).toISOString();

/** A campaign for everyone with a closing time in the future, already started. */
async function timedCampaign() {
  const admin = await login(app, ADMIN_A);
  const c = await makeCampaign(admin, 2, 'Timed vote');
  await admin.patch(`/api/campaigns/${c.id}`).send({ closes_at: future() }).expect(200);
  await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
  return { admin, ...c };
}

describe('SEC-01: no steering and no small-count inference', () => {
  it('while open, the creator gets turnout only: no per-candidate count anywhere in the response', async () => {
    const c = await timedCampaign();
    await (await login(app, S1)).post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
    const r = (await c.admin.get(`/api/campaigns/${c.id}/results`).expect(200)).body;
    expect(r.candidates).toBeNull();
    expect(r.turnout.votes).toBe(1);
    expect(JSON.stringify(r)).not.toContain(c.candidates[0]);
    // the other admin views of an open campaign carry no per-candidate counts either
    const summary = JSON.stringify((await c.admin.get('/api/campaigns/summary').expect(200)).body);
    expect(summary).not.toContain('"votes":1');
    expect(JSON.stringify((await c.admin.get(`/api/campaigns/${c.id}`).expect(200)).body)).not.toContain('"votes"');
    // CSV only after close
    await c.admin.get(`/api/campaigns/${c.id}/results.csv`).expect(409);
  });

  it('a draft shows no counts either, and after close the counts are there', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2);
    expect((await admin.get(`/api/campaigns/${c.id}/results`).expect(200)).body.candidates).toBeNull();
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    await (await login(app, S1)).post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[1] }).expect(201);
    await admin.post(`/api/campaigns/${c.id}/close`).expect(200);     // no closing time set: no reason needed
    const r = (await admin.get(`/api/campaigns/${c.id}/results`).expect(200)).body;
    expect(r.candidates.map((x: { votes: number }) => x.votes)).toEqual([0, 1]);
  });

  it('closing before the planned closing time needs a reason; with one it works and is listed for voters', async () => {
    const c = await timedCampaign();
    const voter = await login(app, S1);
    await voter.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);

    expect((await c.admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(400)).body.code).toBe('reason_required');
    await c.admin.post(`/api/campaigns/${c.id}/close`).send({ reason: 'short' }).expect(400);
    expect((await ownerDb().query('SELECT status FROM campaigns WHERE id = $1', [c.id])).rows[0].status).toBe('open');
    await c.admin.post(`/api/campaigns/${c.id}/close`).send({ reason: REASON, extra: 1 }).expect(400);

    await c.admin.post(`/api/campaigns/${c.id}/close`).send({ reason: REASON }).expect(200);
    const entry = (await ownerDb().query("SELECT details FROM audit_log WHERE campaign_id = $1 AND action = 'campaign.close'", [c.id])).rows[0].details;
    expect(entry).toMatchObject({ early: true, why: REASON });

    // the voter sees it on the ballot page ...
    const page = (await voter.get(`/api/vote/${c.token}`).expect(200)).body;
    expect(page.notices).toEqual([expect.objectContaining({ kind: 'closed_early', reason: REASON, by: 'Alice Admin' })]);
    // ... and in the published results
    await c.admin.post(`/api/campaigns/${c.id}/publish`).expect(200);
    const res = (await voter.get(`/api/vote/${c.token}/results`).expect(200)).body;
    expect(res.notices).toEqual([expect.objectContaining({ kind: 'closed_early', reason: REASON })]);
  });

  it('a reset is announced to voters on the ballot page with its reason, and the reset round\'s counts stay hidden', async () => {
    const c = await timedCampaign();
    const voter = await login(app, S1);
    await voter.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
    const title = 'Timed vote';
    await c.admin.post(`/api/campaigns/${c.id}/reset`).send({ confirm_title: title, reason: REASON }).expect(200);

    const page = (await voter.get(`/api/vote/${c.token}`).expect(200)).body;
    expect(page.voterState).toBe('can_vote');
    expect(page.notices).toEqual([expect.objectContaining({ kind: 'reset', reason: REASON, votes_cleared: 1 })]);
    expect(page.notices[0].candidates).toBeUndefined();
    // the creator learns nothing about the discarded round while the vote is open
    const mine = (await c.admin.get(`/api/campaigns/${c.id}/results`).expect(200)).body;
    expect(mine.candidates).toBeNull();
    expect(mine.resets[0].candidates).toBeUndefined();
    // once the new round is closed the history (with the old counts) is there for the creator
    await c.admin.post(`/api/campaigns/${c.id}/close`).send({ reason: REASON }).expect(200);
    expect((await c.admin.get(`/api/campaigns/${c.id}/results`).expect(200)).body.resets[0].candidates).toBeDefined();
  });
});

describe('SEC-03: one vote per member, not per account', () => {
  async function umojaCampaign() {
    await setMembers([['NAM0101', true], ['NAM0102', true], ['EXE0001', true]]);
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2, 'Umoja vote', 'umoja');
    return { admin, ...c };
  }
  const vote = (s: Awaited<ReturnType<typeof login>>, c: { token: string; candidates: string[] }, i = 0) =>
    s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[i] });

  it('two accounts that carry the same employee code: the second vote is refused and shows "already voted"', async () => {
    const c = await umojaCampaign();
    await c.admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const first = await login(app, { ...S1, employeeCode: 'NAM0101' });
    const second = await login(app, { ...S2, employeeCode: 'NAM0101' });   // e.g. the same person's admin or test account
    await vote(first, c).expect(201);
    expect((await vote(second, c, 1).expect(409)).body.code).toBe('already_voted');
    expect((await second.get(`/api/vote/${c.token}`).expect(200)).body.voterState).toBe('already_voted');
    expect(await count('vote_receipts', c.id)).toBe(1);
    expect(await count('ballots', c.id)).toBe(1);
    expect((await ownerDb().query('SELECT member_key FROM vote_receipts WHERE campaign_id = $1', [c.id])).rows[0].member_key).toBe('code:NAM0101');
  });

  it('an account matched by oid and another account that carries the same member\'s code count as one voter (oid first, then code)', async () => {
    const c = await umojaCampaign();
    await ownerDb().query("UPDATE umoja_members SET entra_oid = $1 WHERE employee_code = 'NAM0101'", [S1.oid]);
    await c.admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const byOid = await login(app, { ...S1, employeeCode: null });
    const byCode = await login(app, { ...S2, employeeCode: 'NAM0101' });
    await vote(byCode, c).expect(201);
    await vote(byOid, c, 1).expect(409);
    expect(await count('vote_receipts', c.id)).toBe(1);
  });

  it('an account match beats a code match: an oid that points at member A cannot vote as member B by carrying B\'s code', async () => {
    const c = await umojaCampaign();
    await ownerDb().query("UPDATE umoja_members SET entra_oid = $1 WHERE employee_code = 'NAM0101'", [S1.oid]);
    await c.admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const liar = await login(app, { ...S1, employeeCode: 'NAM0102' });
    await vote(liar, c).expect(201);
    expect((await ownerDb().query('SELECT member_key FROM vote_receipts WHERE campaign_id = $1', [c.id])).rows[0].member_key).toBe('code:NAM0101');
    await vote(await login(app, { ...S3, employeeCode: 'NAM0102' }), c).expect(201);   // the real NAM0102 can still vote
  });

  it('control: different members vote; campaigns for everyone still count one vote per account', async () => {
    const c = await umojaCampaign();
    await c.admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    await vote(await login(app, { ...S1, employeeCode: 'NAM0101' }), c).expect(201);
    await vote(await login(app, { ...S2, employeeCode: 'NAM0102' }), c).expect(201);
    expect(await count('vote_receipts', c.id)).toBe(2);
    const admin = await login(app, ADMIN_A);
    const all = await makeCampaign(admin, 2, 'Everyone');
    await admin.post(`/api/campaigns/${all.id}/start`).expect(200);
    await vote(await login(app, S1), all).expect(201);
    await vote(await login(app, S2), all).expect(201);
    await vote(await login(app, S1), all).expect(409);
  });

  it('the database enforces it too: one receipt per (campaign, member_key)', async () => {
    const c = await umojaCampaign();
    await c.admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    await vote(await login(app, { ...S1, employeeCode: 'NAM0101' }), c).expect(201);
    await expect(ownerDb().query("INSERT INTO vote_receipts (campaign_id, voter_oid, member_key) VALUES ($1, $2, 'code:NAM0101')", [c.id, S3.oid])).rejects.toThrow(/vote_receipts_member_unique|unique|duplicate|foreign key/);
  });
});

describe('SEC-05 + SEC-04: frozen voter list and a sealed, hash-chained result', () => {
  it('the snapshot holds identities only (no names, no emails)', async () => {
    const cols = await ownerDb().query("SELECT column_name FROM information_schema.columns WHERE table_name = 'campaign_voters' ORDER BY column_name");
    expect(cols.rows.map((r) => r.column_name)).toEqual(['active', 'campaign_id', 'entra_oid', 'member_code']);
  });

  async function closedCampaign() {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2, 'Sealed vote');
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    for (const [i, u] of [S1, S2, S3].entries()) await (await login(app, u)).post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[i === 2 ? 1 : 0] }).expect(201);
    await admin.post(`/api/campaigns/${c.id}/close`).expect(200);
    return { admin, ...c };
  }
  const chain = async () => (await ownerDb().query('SELECT audit_chain_verify() AS r')).rows[0].r as { ok: boolean; checked: number; broken_at_seq?: number };

  it('close seals the final tallies and turnout in the audit chain; "Verify results integrity" passes', async () => {
    const c = await closedCampaign();
    const e = (await ownerDb().query("SELECT * FROM audit_log WHERE campaign_id = $1 AND action = 'campaign.close'", [c.id])).rows[0];
    expect(e.details).toMatchObject({ ballots: 3, receipts: 3, match: true });
    expect(e.details.tallies.map((t: { votes: number }) => t.votes)).toEqual([2, 1]);
    expect(e.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(e.prev_hash).toMatch(/^[0-9a-f]{64}$/);
    expect((await chain()).ok).toBe(true);
    const v = (await c.admin.get(`/api/campaigns/${c.id}/verify`).expect(200)).body;
    expect(v).toMatchObject({ chain_ok: true, sealed: true, tallies_match: true, receipts_match: true, sealed_turnout: 3, seal_hash: e.hash });
    expect(v.sealed_tallies.map((t: { votes: number }) => t.votes)).toEqual([2, 1]);
    // only the creator can ask
    await (await login(app, S1)).get(`/api/campaigns/${c.id}/verify`).expect(403);
  });

  it('changing a sealed entry, a counter or a receipt afterwards is detected', async () => {
    const c = await closedCampaign();
    await ownerDb().query("UPDATE tallies SET votes = votes + 5 WHERE candidate_id = $1", [c.candidates[0]]);
    const v1 = (await c.admin.get(`/api/campaigns/${c.id}/verify`).expect(200)).body;
    expect(v1).toMatchObject({ chain_ok: true, tallies_match: false });
    await ownerDb().query("UPDATE tallies SET votes = votes - 5 WHERE candidate_id = $1", [c.candidates[0]]);
    expect((await c.admin.get(`/api/campaigns/${c.id}/verify`).expect(200)).body.tallies_match).toBe(true);

    await ownerDb().query("DELETE FROM vote_receipts WHERE voter_oid = $1", [S1.oid]);
    expect((await c.admin.get(`/api/campaigns/${c.id}/verify`).expect(200)).body.receipts_match).toBe(false);

    // editing the sealed entry itself breaks the chain
    await ownerDb().query("UPDATE audit_log SET details = jsonb_set(details, '{tallies,0,votes}', '99') WHERE campaign_id = $1 AND action = 'campaign.close'", [c.id]);
    const v2 = (await c.admin.get(`/api/campaigns/${c.id}/verify`).expect(200)).body;
    expect(v2.chain_ok).toBe(false);
    expect((await chain()).ok).toBe(false);
  });

  it('removing or re-ordering an audit entry breaks the chain', async () => {
    const c = await closedCampaign();
    expect((await chain()).ok).toBe(true);
    await ownerDb().query("DELETE FROM audit_log WHERE campaign_id = $1 AND action = 'campaign.start'", [c.id]);
    const r = await chain();
    expect(r.ok).toBe(false);
    expect(r.broken_at_seq).toBeGreaterThan(0);
  });

  it('the app role cannot touch the chain columns or the audit log, and cannot forge an entry that skips the chain', async () => {
    const c = await closedCampaign();
    const pg = (await import('pg')).default;
    const db = new pg.Client({ connectionString: 'postgres://namra_app:namra_app_dev@localhost:5433/namra_test' });
    await db.connect();
    try {
      await expect(db.query("UPDATE audit_log SET hash = 'x'")).rejects.toThrow(/permission denied/);
      await expect(db.query('DELETE FROM audit_log')).rejects.toThrow(/permission denied/);
      // an insert that names its own hash/seq is overwritten by the trigger: the chain stays valid
      await db.query("INSERT INTO audit_log (action, campaign_id, details, seq, prev_hash, hash) VALUES ('x', $1, '{}', 1, 'a', 'b')", [c.id]);
    } finally { await db.end(); }
    expect((await chain()).ok).toBe(true);
  });

  it('concurrent audit writes get a gap-free sequence and a valid chain', async () => {
    const admin = await login(app, ADMIN_A);
    await Promise.all(Array.from({ length: 25 }, (_, i) => admin.post('/api/campaigns').send({ title: `Parallel ${i}` }).expect(201)));
    const seqs = (await ownerDb().query('SELECT seq::int FROM audit_log ORDER BY seq')).rows.map((r) => r.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(seqs.length).toBeGreaterThanOrEqual(25);
    expect((await chain()).ok).toBe(true);
  });

  it('a permanent delete keeps the sealed result in the audit log, and verification says so', async () => {
    const c = await closedCampaign();
    await c.admin.post(`/api/campaigns/${c.id}/archive`).expect(200);
    await c.admin.get(`/api/campaigns/${c.id}/results.csv`).expect(200);
    await c.admin.post(`/api/campaigns/${c.id}/permanent-delete`).send({ confirm_title: 'Sealed vote' }).expect(200);
    const sealed = (await ownerDb().query("SELECT details FROM audit_log WHERE campaign_id = $1 AND action = 'campaign.close'", [c.id])).rows;
    expect(sealed).toHaveLength(1);
    expect(sealed[0].details.tallies.map((t: { votes: number }) => t.votes)).toEqual([2, 1]);
    expect((await chain()).ok).toBe(true);
    // the campaign row is gone, so the API answers 404 for it; the chain and the sealed entry are what remain
    await c.admin.get(`/api/campaigns/${c.id}/verify`).expect(404);
  });
});
