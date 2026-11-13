// The rules hooks are really the ONLY place that decides who may be chosen and who has won: replacing them changes the vote and the result
// without touching anything else (docs/rules-hooks.md). Here a "blocked region" rule and a "two seats" rule are bolted on through the two hooks.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/domain/rules.js', async (original) => {
  const real = await original<typeof import('../../src/domain/rules.js')>();
  return {
    ...real,
    // demo rule 1 (validateBallot): nobody may vote for a candidate from the region named in the position's rules {"blockRegion": "..."}
    validateBallot: (position: { rules: Record<string, unknown> }, member: unknown, candidate: { regionName: string | null; withdrawn: boolean; isAbstain: boolean }) => {
      real.validateBallot(position as never, member as never, candidate as never);
      if (position.rules.blockRegion && candidate.regionName === position.rules.blockRegion) throw new real.BallotRejected('This region is not open in this position', 'region_blocked', 409);
    },
    // demo rule 2 (computeResult): a position whose rules say {"seatsWon": 2} sends its top two to the result
    computeResult: (position: { rules: Record<string, unknown> }, tallies: { id: string; name: string; votes: number; is_abstain?: boolean; withdrawn?: boolean }[]) => {
      const n = Number(position.rules.seatsWon ?? 0);
      if (!n) return real.computeResult(position as never, tallies as never);
      const live = tallies.filter((x) => !x.is_abstain && !x.withdrawn).sort((a, b) => b.votes - a.votes);
      return { winners: live.slice(0, n), tied: [] };
    },
  };
});

const { createApp } = await import('../../src/app.js');
const { closePool } = await import('../../src/db.js');
const { ADMIN_A, S1, S2, S3, closeOwner, login, makeElection, ownerDb, resetDb } = await import('../helpers.js');

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

describe('a rule plugged into validateBallot', () => {
  it('refuses the ballot inside the vote transaction: no receipt, no count, the position is still open for another choice', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'P', candidates: [{ name: 'North', region: 'Kunene' }, { name: 'Central', region: 'Khomas' }] }] });
    await ownerDb().query('UPDATE positions SET rules = $2 WHERE id = $1', [e.positions[0].id, JSON.stringify({ blockRegion: 'Kunene' })]);   // rules are set while a draft: the database locks them at start
    await admin.post(`/api/campaigns/${e.id}/start`).expect(200);
    const me = await login(app, S1);
    const refused = await me.post(`/api/vote/${e.token}/positions/${e.positions[0].id}`).send({ candidateId: e.positions[0].candidates[0].id }).expect(409);
    expect(refused.body.code).toBe('region_blocked');
    expect((await ownerDb().query('SELECT count(*)::int AS n FROM vote_receipts WHERE campaign_id = $1', [e.id])).rows[0].n).toBe(0);
    expect((await ownerDb().query('SELECT coalesce(sum(votes), 0)::int AS n FROM tallies WHERE campaign_id = $1', [e.id])).rows[0].n).toBe(0);
    await me.post(`/api/vote/${e.token}/positions/${e.positions[0].id}`).send({ candidateId: e.positions[0].candidates[1].id }).expect(201);
  });

  it('keeps the built-in refusal of a withdrawn candidate', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'P', candidates: ['A', 'B', 'C'] }], start: true });
    await admin.post(`/api/campaigns/${e.id}/candidates/${e.positions[0].candidates[2].id}/withdraw`).send({ reason: 'Leaving the company' }).expect(200);
    expect((await (await login(app, S1)).post(`/api/vote/${e.token}/positions/${e.positions[0].id}`).send({ candidateId: e.positions[0].candidates[2].id }).expect(409)).body.code).toBe('candidate_withdrawn');
  });
});

describe('a rule plugged into computeResult', () => {
  it('decides the winners of one position, and the results and the CSV read it from the same place', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'Committee (2 seats)', candidates: ['A', 'B', 'C'] }, { title: 'Chair', candidates: ['D', 'E'] }] });
    await ownerDb().query('UPDATE positions SET rules = $2 WHERE id = $1', [e.positions[0].id, JSON.stringify({ seatsWon: 2 })]);
    await admin.post(`/api/campaigns/${e.id}/start`).expect(200);
    await expect(ownerDb().query('UPDATE positions SET rules = $2 WHERE id = $1', [e.positions[0].id, '{}'])).rejects.toThrow(/locked/);   // rules cannot change once voting has started
    const votes: [typeof S1, number, number][] = [[S1, 0, 0], [S2, 0, 1], [S3, 0, 0]];
    for (const [u, p, c] of votes) await (await login(app, u)).post(`/api/vote/${e.token}/positions/${e.positions[p].id}`).send({ candidateId: e.positions[p].candidates[c].id }).expect(201);
    await admin.post(`/api/campaigns/${e.id}/close`).send({ reason: 'Closing for the test run' }).expect(200);
    const r = (await admin.get(`/api/campaigns/${e.id}/results`).expect(200)).body;
    expect(r.positions[0].winners.map((w: { name: string }) => w.name)).toEqual(['A', 'B']);      // the rule's two seats
    expect(r.positions[1].winners).toEqual([]);                                                    // the default rule elsewhere: nobody voted
    const csv = (await admin.get(`/api/campaigns/${e.id}/results.csv`).expect(200)).text;
    expect(csv).toContain('Committee (2 seats),"Winner: A, B",,');
  });
});
