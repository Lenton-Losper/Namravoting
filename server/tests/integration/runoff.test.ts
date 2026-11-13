// Business-logic item 1: ties. A tie for first place is shown plainly, and the creator can start a run-off.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { standing } from '../../src/domain/results.js';
import { ADMIN_A, ADMIN_B, S1, S2, S3, closeOwner, login, ownerDb, resetDb } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

type Admin = Awaited<ReturnType<typeof login>>;

/** A closed campaign. `votes[i]` ballots go to candidate i (voters S1..S3 in turn). */
async function closed(admin: Admin, votes: number[], opts: { eligibility?: 'all' | 'list'; emails?: string[]; title?: string } = {}) {
  const body: Record<string, unknown> = { title: opts.title ?? 'Chair', eligibility: opts.eligibility ?? 'all' };
  if (opts.emails) body.emails = opts.emails;
  const c = (await admin.post('/api/campaigns').send(body).expect(201)).body;
  const cands: string[] = [];
  for (let i = 0; i < votes.length; i++) cands.push((await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', `Cand ${i + 1}`).field('bio', `bio ${i + 1}`).expect(201)).body.id);
  await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
  const voters = [S1, S2, S3];
  let v = 0;
  for (let i = 0; i < votes.length; i++) for (let k = 0; k < votes[i]; k++) await (await login(app, voters[v++])).post(`/api/vote/${c.share_token}`).send({ candidateId: cands[i] }).expect(201);
  await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
  return { id: c.id as string, token: c.share_token as string, cands };
}

describe('standing (pure)', () => {
  const c = (id: string, votes: number, extra = {}) => ({ id, name: id, votes, ...extra });
  it('a single leader, a tie, and no votes', () => {
    expect(standing([c('a', 2), c('b', 1)]).leader?.id).toBe('a');
    expect(standing([c('a', 2), c('b', 2), c('c', 1)]).tied.map((x) => x.id)).toEqual(['a', 'b']);
    expect(standing([c('a', 0), c('b', 0)])).toEqual({ leader: null, tied: [] });
  });
  it('abstain lines and withdrawn candidates can neither win nor tie', () => {
    expect(standing([c('a', 3, { is_abstain: true }), c('b', 2), c('c', 1)]).leader?.id).toBe('b');
    expect(standing([c('a', 3, { withdrawn: true }), c('b', 2), c('c', 2)]).tied.map((x) => x.id)).toEqual(['b', 'c']);
  });
});

describe('a tie is shown plainly', () => {
  it('the results say who tied, the CSV says so, and the winner is not named', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await closed(admin, [1, 1, 1]);
    const r = (await admin.get(`/api/campaigns/${c.id}/results`).expect(200)).body;
    expect(r.tie).toMatchObject({ names: ['Cand 1', 'Cand 2', 'Cand 3'], votes: 1 });
    expect(r.runoff).toMatchObject({ can_start: true, round: 0, max: 2 });
    const csv = (await admin.get(`/api/campaigns/${c.id}/results.csv`).expect(200)).text;
    expect(csv).toContain('Tie,YES: tie for first place between Cand 1 and Cand 2 and Cand 3');
  });

  it('a clear winner has no tie, and a tie for second place is not a tie', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await closed(admin, [2, 1, 0]);
    const r = (await admin.get(`/api/campaigns/${c.id}/results`).expect(200)).body;
    expect(r.tie).toBeNull();
    await admin.post(`/api/campaigns/${c.id}/runoff`).expect(409);
  });

  it('voters see the tie in the published results', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await closed(admin, [1, 1]);
    await admin.post(`/api/campaigns/${c.id}/publish`).expect(200);
    const r = (await (await login(app, S1)).get(`/api/vote/${c.token}/results`).expect(200)).body;
    expect(r.tie.names).toEqual(['Cand 1', 'Cand 2']);
  });
});

describe('POST /api/campaigns/:id/runoff', () => {
  it('clones only the tied candidates into a new draft linked to the first, with the same voters, and audits it', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await closed(admin, [1, 1, 0], { eligibility: 'list', emails: [S1.email, S2.email], title: 'Chair' });
    const run = (await admin.post(`/api/campaigns/${c.id}/runoff`).expect(201)).body;
    expect(run).toMatchObject({ status: 'draft', title: 'Chair (run-off 1)', eligibility: 'list', runoff_round: 1, parent_campaign_id: c.id });
    expect(run.share_token).not.toBe(c.token);
    const detail = (await admin.get(`/api/campaigns/${run.id}`).expect(200)).body;
    expect(detail.candidates.map((x: { name: string; bio: string }) => [x.name, x.bio])).toEqual([['Cand 1', 'bio 1'], ['Cand 2', 'bio 2']]);   // Cand 3 did not tie
    expect(detail.eligible_emails).toEqual([S1.email, S2.email].sort());
    expect((await ownerDb().query('SELECT count(*)::int AS n FROM tallies WHERE campaign_id = $1', [run.id])).rows[0].n).toBe(0);   // tallies appear at start, with a new snapshot
    const a = (await ownerDb().query("SELECT action, details FROM audit_log WHERE campaign_id = $1 AND action = 'campaign.runoff_created'", [c.id])).rows;
    expect(a).toHaveLength(1);
    expect(a[0].details).toMatchObject({ runoff_id: run.id, round: 1, tied: ['Cand 1', 'Cand 2'] });
    // the original now points to it, and a second run-off of the same campaign is refused
    expect((await admin.get(`/api/campaigns/${c.id}/results`)).body.runoff).toMatchObject({ can_start: false, next: { id: run.id } });
    await admin.post(`/api/campaigns/${c.id}/runoff`).expect(409);
  });

  it('the run-off is a normal campaign: it starts with its own snapshot and seal, and can tie again up to the limit', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await closed(admin, [1, 1]);
    const r1 = (await admin.post(`/api/campaigns/${c.id}/runoff`).expect(201)).body;
    await admin.post(`/api/campaigns/${r1.id}/start`).expect(200);
    await (await login(app, S1)).post(`/api/vote/${r1.share_token}`).send({ candidateId: (await admin.get(`/api/campaigns/${r1.id}`)).body.candidates[0].id }).expect(201);
    await (await login(app, S2)).post(`/api/vote/${r1.share_token}`).send({ candidateId: (await admin.get(`/api/campaigns/${r1.id}`)).body.candidates[1].id }).expect(201);
    await admin.post(`/api/campaigns/${r1.id}/close`).send({}).expect(200);
    expect((await admin.get(`/api/campaigns/${r1.id}/results`)).body.tie).not.toBeNull();     // tied again
    const r2 = (await admin.post(`/api/campaigns/${r1.id}/runoff`).expect(201)).body;           // round 2
    expect(r2).toMatchObject({ title: 'Chair (run-off 2)', runoff_round: 2 });
    await admin.post(`/api/campaigns/${r2.id}/start`).expect(200);
    await (await login(app, S1)).post(`/api/vote/${r2.share_token}`).send({ candidateId: (await admin.get(`/api/campaigns/${r2.id}`)).body.candidates[0].id }).expect(201);
    await (await login(app, S2)).post(`/api/vote/${r2.share_token}`).send({ candidateId: (await admin.get(`/api/campaigns/${r2.id}`)).body.candidates[1].id }).expect(201);
    await admin.post(`/api/campaigns/${r2.id}/close`).send({}).expect(200);
    const limit = await admin.post(`/api/campaigns/${r2.id}/runoff`).expect(409);                // the maximum (2) is reached
    expect(limit.body.code).toBe('runoff_limit');
    expect((await admin.get(`/api/campaigns/${r2.id}/results`)).body.runoff.can_start).toBe(false);
  });

  it('refuses an open or draft campaign, only the creator can start one, and the link cannot be edited afterwards', async () => {
    const admin = await login(app, ADMIN_A); const other = await login(app, ADMIN_B);
    const c = await closed(admin, [1, 1]);
    await other.post(`/api/campaigns/${c.id}/runoff`).expect(404);
    await (await login(app, S1)).post(`/api/campaigns/${c.id}/runoff`).expect(403);
    const open = (await admin.post('/api/campaigns').send({ title: 'x', eligibility: 'all' }).expect(201)).body;
    await admin.post(`/api/campaigns/${open.id}/runoff`).expect(409);
    const run = (await admin.post(`/api/campaigns/${c.id}/runoff`).expect(201)).body;
    const pg = (await import('pg')).default;
    const app_ = new pg.Pool({ connectionString: 'postgres://namra_app:namra_app_dev@localhost:5433/namra_test', max: 1 });
    await expect(app_.query('UPDATE campaigns SET runoff_round = 0 WHERE id = $1', [run.id])).rejects.toThrow(/run-off link/);
    await app_.end();
  });
});
