// Business-logic item 3: co-admins, observers and a second approver for reset and permanent delete.
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { ADMIN_A, ADMIN_B, S1, S2, S3, TEST_APP_URL, closeOwner, login, ownerDb, resetDb } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); await appRole.end(); });
const appRole = new pg.Pool({ connectionString: TEST_APP_URL, max: 2 });

type S = Awaited<ReturnType<typeof login>>;

/** Owner A, co-admin B, observer S1 (S1 and B have signed in once, so they exist). */
async function setup(opts: { require_approval?: boolean } = {}) {
  const A = await login(app, ADMIN_A); const B = await login(app, ADMIN_B); const o = await login(app, S1);
  const c = (await A.post('/api/campaigns').send({ title: 'Team vote', eligibility: 'all', ...(opts.require_approval ? { require_approval: true } : {}) }).expect(201)).body;
  const cands: string[] = [];
  for (const n of ['One', 'Two']) cands.push((await A.post(`/api/campaigns/${c.id}/candidates`).field('name', n).expect(201)).body.id);
  await A.post(`/api/campaigns/${c.id}/team`).send({ email: ADMIN_B.email, role: 'co_admin' }).expect(201);
  await A.post(`/api/campaigns/${c.id}/team`).send({ email: S1.email, role: 'observer' }).expect(201);
  return { A, B, o, id: c.id as string, token: c.share_token as string, cands };
}
const vote = async (token: string, who: typeof S1, cand: string) => (await login(app, who)).post(`/api/vote/${token}`).send({ candidateId: cand }).expect(201);

describe('the team', () => {
  it('the owner adds co-admins and observers by email; the list shows them', async () => {
    const t = await setup();
    const team = (await t.A.get(`/api/campaigns/${t.id}/team`).expect(200)).body;
    expect(team.owner.email).toBe(ADMIN_A.email);
    expect(team.members.map((m: { email: string; role: string }) => [m.email, m.role]).sort()).toEqual([[ADMIN_B.email, 'co_admin'], [S1.email, 'observer']].sort());
    const a = (await ownerDb().query("SELECT action, details FROM audit_log WHERE campaign_id = $1 AND action = 'team.add' ORDER BY seq", [t.id])).rows;
    expect(a.map((x) => x.details.role)).toEqual(['co_admin', 'observer']);
  });

  it('refuses people who have never signed in, owners, duplicates, and a co-admin who is not an administrator', async () => {
    const t = await setup();
    await login(app, S2);
    expect((await t.A.post(`/api/campaigns/${t.id}/team`).send({ email: 'nobody@nowhere.test', role: 'observer' }).expect(404)).body.code).toBe('no_such_user');
    expect((await t.A.post(`/api/campaigns/${t.id}/team`).send({ email: ADMIN_A.email, role: 'observer' }).expect(400)).body.code).toBe('is_owner');
    expect((await t.A.post(`/api/campaigns/${t.id}/team`).send({ email: S1.email, role: 'observer' }).expect(409)).body.code).toBe('already_member');
    expect((await t.A.post(`/api/campaigns/${t.id}/team`).send({ email: S2.email, role: 'co_admin' }).expect(409)).body.code).toBe('not_admin');
    await t.A.post(`/api/campaigns/${t.id}/team`).send({ email: S2.email, role: 'boss' }).expect(400);
  });

  it('only the owner manages the team; removing someone ends their access and is audited', async () => {
    const t = await setup();
    await t.B.post(`/api/campaigns/${t.id}/team`).send({ email: S2.email, role: 'observer' }).expect(404);          // a co-admin cannot
    await t.B.del(`/api/campaigns/${t.id}/team/${S1.oid}`).expect(404);                                              // nor remove anyone
    const oid = ADMIN_B.oid;
    await t.A.del(`/api/campaigns/${t.id}/team/${oid}`).expect(204);
    await t.B.get(`/api/campaigns/${t.id}`).expect(404);
    expect((await ownerDb().query("SELECT count(*)::int AS n FROM audit_log WHERE campaign_id = $1 AND action = 'team.remove'", [t.id])).rows[0].n).toBe(1);
  });
});

describe('a co-admin can run the campaign, but not do the owner-only things', () => {
  it('can see it on their dashboard, edit, add candidates, start, close, publish and export', async () => {
    const t = await setup();
    expect((await t.B.get(`/api/campaigns/${t.id}`).expect(200)).body.my_role).toBe('co_admin');
    expect((await t.B.get('/api/campaigns/mine').expect(200)).body.campaigns.map((c: { id: string }) => c.id)).toContain(t.id);
    await t.B.patch(`/api/campaigns/${t.id}`).send({ title: 'Team vote (edited)' }).expect(200);
    await t.B.post(`/api/campaigns/${t.id}/candidates`).field('name', 'Three').expect(201);
    await t.B.post(`/api/campaigns/${t.id}/start`).expect(200);
    await vote(t.token, S2, t.cands[0]);
    await t.B.post(`/api/campaigns/${t.id}/close`).send({}).expect(200);
    await t.B.post(`/api/campaigns/${t.id}/publish`).expect(200);
    for (const f of ['csv', 'xlsx', 'pdf']) await t.B.get(`/api/campaigns/${t.id}/results.${f}`).expect(200);
    expect((await ownerDb().query("SELECT actor_oid FROM audit_log WHERE campaign_id = $1 AND action = 'campaign.start'", [t.id])).rows[0].actor_oid).toBe(ADMIN_B.oid);   // audited as the person who did it
  });

  it('cannot reset, delete, archive, run-off the team, or ask for approvals', async () => {
    const t = await setup();
    await t.B.del(`/api/campaigns/${t.id}`).expect(404);
    await t.B.post(`/api/campaigns/${t.id}/archive`).expect(404);
    await t.B.post(`/api/campaigns/${t.id}/reset`).send({ confirm_title: 'Team vote', reason: 'a reason long enough' }).expect(404);
    await t.B.post(`/api/campaigns/${t.id}/permanent-delete`).send({ confirm_title: 'Team vote' }).expect(404);
    await t.B.post(`/api/campaigns/${t.id}/approvals`).send({ kind: 'reset', confirm_title: 'Team vote', reason: 'a reason long enough' }).expect(404);
    await t.B.put(`/api/campaigns/${t.id}/approval-policy`).send({ require_approval: true }).expect(404);
  });

  it('an observer is not an administrator: the admin area is closed to them', async () => {
    const t = await setup();
    await t.o.get(`/api/campaigns/${t.id}`).expect(403);              // an observer is not an administrator
    await t.o.get('/api/campaigns/mine').expect(403);
  });
});

describe('an observer sees turnout and the sealed result, never live counts', () => {
  it('while open: turnout and the audit trail, but no per-candidate numbers anywhere', async () => {
    const t = await setup();
    await t.A.post(`/api/campaigns/${t.id}/start`).expect(200);
    await vote(t.token, S2, t.cands[0]); await vote(t.token, S3, t.cands[0]);
    const list = (await t.o.get('/api/observe').expect(200)).body.campaigns;
    expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ id: t.id, turnout: 2 });
    const v = (await t.o.get(`/api/observe/${t.id}`).expect(200)).body;
    expect(v).toMatchObject({ status: 'open', result: null, seal: null, turnout: { votes: 2 } });
    expect(v.audit.map((a: { action: string }) => a.action)).toEqual(expect.arrayContaining(['campaign.create', 'campaign.start', 'team.add']));
    expect(JSON.stringify(v)).not.toMatch(/"votes":\s*[0-9]+,\s*"name"|tallies/);                 // no tally rows
    expect(v.team.map((m: { role: string }) => m.role).sort()).toEqual(['co_admin', 'observer']);
  });

  it('after a reset the old round\'s per-candidate counts stay hidden while open, and appear (as for everyone) once closed', async () => {
    const t = await setup();
    await t.A.post(`/api/campaigns/${t.id}/start`).expect(200);
    await vote(t.token, S2, t.cands[1]);
    await t.A.post(`/api/campaigns/${t.id}/reset`).send({ confirm_title: 'Team vote', reason: 'Testing the reset of a vote' }).expect(200);
    const open = (await t.o.get(`/api/observe/${t.id}`).expect(200)).body;
    const reset = open.audit.find((a: { action: string }) => a.action === 'campaign.reset');
    expect(reset.details.snapshot).toEqual({ turnout: { ballots: 1, votes: 1 } });
    expect(JSON.stringify(open.notices)).not.toContain('"candidates"');
    await t.A.post(`/api/campaigns/${t.id}/close`).send({}).expect(200);
    const closed = (await t.o.get(`/api/observe/${t.id}`).expect(200)).body;
    expect(closed.result.candidates).toHaveLength(2);
    expect(closed.seal).toMatchObject({ chain_ok: true, sealed: true });
  });

  it('only an observer of that campaign: other staff and co-admins get 404, the denial is audited', async () => {
    const t = await setup();
    const s2 = await login(app, S2);
    await s2.get(`/api/observe/${t.id}`).expect(404);
    await t.B.get(`/api/observe/${t.id}`).expect(404);                 // a co-admin is not an observer
    expect((await s2.get('/api/observe').expect(200)).body.campaigns).toEqual([]);
    expect((await ownerDb().query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'authz.denied' AND details->>'reason' = 'not_observer'")).rows[0].n).toBeGreaterThan(0);
    await (await import('supertest')).default(app).get(`/api/observe/${t.id}`).expect(401);
  });

  it('/api/session tells an observer how many campaigns they observe (and nobody else)', async () => {
    const t = await setup();
    expect((await t.o.get('/api/session').expect(200)).body.observing).toBe(1);
    expect((await t.A.get('/api/session').expect(200)).body.observing).toBe(0);
  });
});

describe('second approver for reset and permanent delete', () => {
  const body = { confirm_title: 'Team vote', reason: 'Wrong candidate list was shown' };

  it('with the rule on, a direct reset is refused and the request flow works end to end', async () => {
    const t = await setup({ require_approval: true });
    await t.A.post(`/api/campaigns/${t.id}/start`).expect(200);
    await vote(t.token, S2, t.cands[0]);
    expect((await t.A.post(`/api/campaigns/${t.id}/reset`).send(body).expect(409)).body.code).toBe('approval_required');

    await t.A.post(`/api/campaigns/${t.id}/approvals`).send({ kind: 'reset', ...body, confirm_title: 'wrong' }).expect(400);
    await t.A.post(`/api/campaigns/${t.id}/approvals`).send({ kind: 'reset', confirm_title: 'Team vote', reason: 'short' }).expect(400);
    const req = (await t.A.post(`/api/campaigns/${t.id}/approvals`).send({ kind: 'reset', ...body }).expect(201)).body;
    await t.A.post(`/api/campaigns/${t.id}/approvals`).send({ kind: 'reset', ...body }).expect(409);               // one open request at a time

    const aid = req.id as string;
    expect((await t.A.post(`/api/campaigns/${t.id}/approvals/${aid}/execute`).expect(409)).body.code).toBe('not_approved');
    expect((await t.A.post(`/api/campaigns/${t.id}/approvals/${aid}/approve`).expect(403)).body.code).toBe('not_co_admin');   // the requester cannot approve
    await t.o.post(`/api/campaigns/${t.id}/approvals/${aid}/approve`).expect(403);                                  // neither can an observer
    await t.B.post(`/api/campaigns/${t.id}/approvals/${aid}/approve`).send({ note: 'Agreed, list was wrong' }).expect(200);
    await t.B.post(`/api/campaigns/${t.id}/approvals/${aid}/approve`).expect(409);                                  // already decided
    expect((await ownerDb().query('SELECT count(*)::int AS n FROM vote_receipts WHERE campaign_id = $1', [t.id])).rows[0].n).toBe(1);   // nothing happened yet

    const ex = (await t.A.post(`/api/campaigns/${t.id}/approvals/${aid}/execute`).expect(200)).body;
    expect(ex).toMatchObject({ executed: true, result: { status: 'open', votes_cleared: 1 } });
    expect((await ownerDb().query('SELECT count(*)::int AS n FROM vote_receipts WHERE campaign_id = $1', [t.id])).rows[0].n).toBe(0);
    await t.A.post(`/api/campaigns/${t.id}/approvals/${aid}/execute`).expect(409);                                  // once only
    const actions = (await ownerDb().query("SELECT action, actor_oid FROM audit_log WHERE campaign_id = $1 AND (action LIKE 'approval.%' OR action = 'campaign.reset') ORDER BY seq", [t.id])).rows;
    expect(actions.map((a) => a.action)).toEqual(['approval.requested', 'approval.approved', 'campaign.reset', 'approval.executed']);
    expect(actions[1].actor_oid).toBe(ADMIN_B.oid);
  });

  it('a rejected or cancelled request cannot be executed; an old approval expires', async () => {
    const t = await setup({ require_approval: true });
    await t.A.post(`/api/campaigns/${t.id}/start`).expect(200);
    const r1 = (await t.A.post(`/api/campaigns/${t.id}/approvals`).send({ kind: 'reset', ...body }).expect(201)).body.id;
    await t.B.post(`/api/campaigns/${t.id}/approvals/${r1}/reject`).send({ note: 'No, not needed' }).expect(200);
    await t.A.post(`/api/campaigns/${t.id}/approvals/${r1}/execute`).expect(409);
    const r2 = (await t.A.post(`/api/campaigns/${t.id}/approvals`).send({ kind: 'reset', ...body }).expect(201)).body.id;
    await t.A.post(`/api/campaigns/${t.id}/approvals/${r2}/cancel`).expect(200);
    await t.B.post(`/api/campaigns/${t.id}/approvals/${r2}/approve`).expect(409);
    const r3 = (await t.A.post(`/api/campaigns/${t.id}/approvals`).send({ kind: 'reset', ...body }).expect(201)).body.id;
    await t.B.post(`/api/campaigns/${t.id}/approvals/${r3}/approve`).expect(200);
    await ownerDb().query("UPDATE approvals SET decided_at = now() - interval '25 hours' WHERE id = $1", [r3]);
    expect((await t.A.post(`/api/campaigns/${t.id}/approvals/${r3}/execute`).expect(409)).body.code).toBe('approval_expired');
  });

  it('permanent delete needs the same two people (and the export first)', async () => {
    const t = await setup({ require_approval: true });
    await t.A.post(`/api/campaigns/${t.id}/start`).expect(200);
    await vote(t.token, S2, t.cands[0]);
    await t.A.post(`/api/campaigns/${t.id}/close`).send({}).expect(200);
    await t.A.get(`/api/campaigns/${t.id}/results.csv`).expect(200);
    await t.A.post(`/api/campaigns/${t.id}/archive`).expect(200);
    expect((await t.A.post(`/api/campaigns/${t.id}/permanent-delete`).send({ confirm_title: 'Team vote' }).expect(409)).body.code).toBe('approval_required');
    const aid = (await t.A.post(`/api/campaigns/${t.id}/approvals`).send({ kind: 'permanent_delete', confirm_title: 'Team vote' }).expect(201)).body.id;
    await t.B.post(`/api/campaigns/${t.id}/approvals/${aid}/approve`).expect(200);
    await t.A.post(`/api/campaigns/${t.id}/approvals/${aid}/execute`).expect(200);
    expect((await ownerDb().query('SELECT count(*)::int AS n FROM campaigns WHERE id = $1', [t.id])).rows[0].n).toBe(0);
    expect((await ownerDb().query("SELECT count(*)::int AS n FROM audit_log WHERE campaign_id = $1 AND action IN ('campaign.delete_permanent','approval.executed')", [t.id])).rows[0].n).toBe(2);
  });

  it('without the rule nothing changes: direct reset works and a request is not needed', async () => {
    const t = await setup();
    await t.A.post(`/api/campaigns/${t.id}/start`).expect(200);
    await t.A.post(`/api/campaigns/${t.id}/approvals`).send({ kind: 'reset', ...body }).expect(409);
    await t.A.post(`/api/campaigns/${t.id}/reset`).send(body).expect(200);
  });

  it('the rule can be switched on but never off: the database refuses, even as the app role', async () => {
    const t = await setup();
    await t.A.put(`/api/campaigns/${t.id}/approval-policy`).send({ require_approval: true }).expect(200);
    await t.A.put(`/api/campaigns/${t.id}/approval-policy`).send({ require_approval: false }).expect(400);
    await expect(appRole.query('UPDATE campaigns SET require_approval = false WHERE id = $1', [t.id])).rejects.toThrow(/cannot be switched off/);
  });

  it('the database itself refuses an approval by the requester, and an edited request', async () => {
    const t = await setup({ require_approval: true });
    await t.A.post(`/api/campaigns/${t.id}/start`).expect(200);
    const aid = (await t.A.post(`/api/campaigns/${t.id}/approvals`).send({ kind: 'reset', ...body }).expect(201)).body.id;
    await expect(appRole.query("UPDATE approvals SET status = 'approved', decided_by = requested_by, decided_at = now() WHERE id = $1", [aid])).rejects.toThrow(/approvals_second_person/);
    await expect(appRole.query("UPDATE approvals SET payload = '{}'::jsonb WHERE id = $1", [aid])).rejects.toThrow(/cannot be changed/);
    await expect(appRole.query("UPDATE approvals SET status = 'executed' WHERE id = $1", [aid])).rejects.toThrow(/illegal approval status change/);
  });
});
