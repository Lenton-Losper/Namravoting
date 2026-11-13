// Voting in a campaign with several positions: independent blocks, one vote per position per member, greyed-out blocks, regions, secrecy.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { ADMIN_A, S1, S2, S3, S4, S5, closeOwner, login, makeElection, ownerDb, resetDb, responseLog, setMembers, type Election } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

type Sess = Awaited<ReturnType<typeof login>>;
const SPEC = [
  { title: 'Press Secretary', candidates: [{ name: 'Alice', region: 'Khomas' }, { name: 'Bob', region: 'Erongo' }, { name: 'Chipo', region: 'Zambezi' }] },
  { title: 'Finance Officer', candidates: [{ name: 'Dana', region: 'Oshana' }, { name: 'Esau', region: 'Khomas' }] },
  { title: 'Treasurer', candidates: [{ name: 'Fiona', region: 'Hardap' }, { name: 'Gideon', region: 'Kunene' }] },
];
async function started(opts: { abstain?: boolean; eligibility?: 'all' | 'umoja' } = {}): Promise<Election & { admin: Sess }> {
  const admin = await login(app, ADMIN_A);
  const e = await makeElection(admin, { positions: SPEC, start: true, abstain: opts.abstain, eligibility: opts.eligibility });
  return { ...e, admin };
}
const cand = (e: Election, p: number, c: number) => e.positions[p].candidates[c].id;
const voteIn = (s: Sess, e: Election, p: number, c: number) => s.post(`/api/vote/${e.token}/positions/${e.positions[p].id}`).send({ candidateId: cand(e, p, c) });
const tally = async (e: Election): Promise<Record<string, number>> => Object.fromEntries((await ownerDb().query(
  'SELECT k.name, t.votes FROM tallies t JOIN candidates k ON k.id = t.candidate_id WHERE t.campaign_id = $1 AND NOT k.is_abstain', [e.id])).rows.map((r) => [r.name as string, r.votes as number]));
const receipts = async (e: Election) => (await ownerDb().query('SELECT count(*)::int AS n FROM vote_receipts WHERE campaign_id = $1', [e.id])).rows[0].n as number;

describe('the voter\'s campaign page', () => {
  it('shows a block per position with progress, and no candidate list for the campaign as a whole', async () => {
    const e = await started();
    const me = await login(app, S1);
    const page = (await me.get(`/api/vote/${e.token}`).expect(200)).body;
    expect(page).toMatchObject({ title: 'Umoja Committee 2026', voterState: 'can_vote', progress: { voted: 0, total: 3 } });
    expect(page.positions.map((p: { title: string; voted: boolean; candidateCount: number }) => [p.title, p.voted, p.candidateCount])).toEqual([['Press Secretary', false, 3], ['Finance Officer', false, 2], ['Treasurer', false, 2]]);
    expect(page.regions).toHaveLength(14);
  });

  it('a position\'s ballot lists its candidates only, each with region, bio and photo fields', async () => {
    const e = await started();
    const me = await login(app, S1);
    const ballot = (await me.get(`/api/vote/${e.token}/positions/${e.positions[1].id}`).expect(200)).body;
    expect(ballot.position.title).toBe('Finance Officer');
    expect(ballot.candidates.map((c: { name: string }) => c.name)).toEqual(['Dana', 'Esau']);
    expect(ballot.candidates[0]).toMatchObject({ region: 'Oshana', regionId: e.regions.Oshana, positionId: e.positions[1].id, isAbstain: false, withdrawn: false });
    expect(ballot.candidates[0]).toHaveProperty('bio');
    expect(ballot.candidates[0]).toHaveProperty('photoUrl');
    // regions for the dropdown filter: the campaign's own list, in order, with the id each candidate points at
    expect(ballot.regions.map((r: { name: string }) => r.name).slice(0, 3)).toEqual(['Erongo', 'Hardap', '//Kharas']);
    for (const c of ballot.candidates) expect(ballot.regions.some((r: { id: string }) => r.id === c.regionId)).toBe(true);
    await me.get(`/api/vote/${e.token}/positions/00000000-0000-4000-8000-000000000000`).expect(404);
    await me.get(`/api/vote/${e.token}/positions/not-a-uuid`).expect(404);
  });

  it('a renamed or extra region is what the voter sees (each campaign has its own list)', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'Press Secretary', candidates: [{ name: 'Alice', region: 'Khomas' }, { name: 'Bob', region: 'Erongo' }] }] });
    await admin.patch(`/api/campaigns/${e.id}/regions/${e.regions.Khomas}`).send({ name: 'Head Office' }).expect(200);
    await admin.post(`/api/campaigns/${e.id}/regions`).send({ name: 'Ongwediva Office' }).expect(201);
    await admin.post(`/api/campaigns/${e.id}/start`).expect(200);
    const ballot = (await (await login(app, S1)).get(`/api/vote/${e.token}/positions/${e.positions[0].id}`).expect(200)).body;
    expect(ballot.candidates.find((c: { name: string }) => c.name === 'Alice').region).toBe('Head Office');
    expect(ballot.regions.map((r: { name: string }) => r.name)).toContain('Ongwediva Office');
    expect(ballot.regions.map((r: { name: string }) => r.name)).not.toContain('Khomas');
  });

  it('is not served for a draft or closed campaign', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'P', candidates: ['A', 'B'] }] });
    const me = await login(app, S1);
    expect((await me.get(`/api/vote/${e.token}/positions/${e.positions[0].id}`).expect(409)).body.code).toBe('not_open');
    expect((await me.get(`/api/vote/${e.token}`).expect(200)).body.positions).toEqual([]);                         // no blocks, no candidates, in a draft
    await admin.post(`/api/campaigns/${e.id}/start`).expect(200);
    await admin.post(`/api/campaigns/${e.id}/close`).send({ reason: 'Closing for the test run' }).expect(200);
    expect((await me.get(`/api/vote/${e.token}/positions/${e.positions[0].id}`).expect(409)).body.code).toBe('closed');
  });
});

describe('voting in several positions', () => {
  it('each position is its own vote: any order, any mix, and the counters and receipts follow', async () => {
    const e = await started();
    const s1 = await login(app, S1); const s2 = await login(app, S2);
    await voteIn(s1, e, 2, 0).expect(201);                              // Treasurer first
    await voteIn(s1, e, 0, 1).expect(201);                              // then Press Secretary
    await voteIn(s2, e, 0, 1).expect(201);
    await voteIn(s2, e, 1, 0).expect(201);
    expect(await tally(e)).toEqual({ Alice: 0, Bob: 2, Chipo: 0, Dana: 1, Esau: 0, Fiona: 1, Gideon: 0 });
    expect(await receipts(e)).toBe(4);
    const per = (await ownerDb().query('SELECT p.title, count(r.*)::int AS n FROM positions p LEFT JOIN vote_receipts r ON r.position_id = p.id WHERE p.campaign_id = $1 GROUP BY p.title ORDER BY p.title', [e.id])).rows;
    expect(per).toEqual([{ title: 'Finance Officer', n: 1 }, { title: 'Press Secretary', n: 2 }, { title: 'Treasurer', n: 1 }]);
  });

  it('shows progress and greys out a block after voting: "2 of 3 positions voted"', async () => {
    const e = await started();
    const me = await login(app, S1);
    await voteIn(me, e, 0, 0).expect(201);
    let page = (await me.get(`/api/vote/${e.token}`).expect(200)).body;
    expect(page.progress).toEqual({ voted: 1, total: 3 });
    expect(page.voterState).toBe('can_vote');
    await voteIn(me, e, 2, 1).expect(201);
    page = (await me.get(`/api/vote/${e.token}`).expect(200)).body;
    expect(page.progress).toEqual({ voted: 2, total: 3 });
    expect(page.positions.map((p: { voted: boolean }) => p.voted)).toEqual([true, false, true]);
    // a position done is not served again: the flat list carries only the position still to vote
    expect(page.candidates.map((c: { name: string }) => c.name)).toEqual(['Dana', 'Esau']);
    const mine = (await me.get('/api/vote').expect(200)).body.campaigns[0];
    expect(mine.positions).toEqual({ voted: 2, total: 3 });
    expect(mine.voterState).toBe('can_vote');
    await voteIn(me, e, 1, 1).expect(201);
    page = (await me.get(`/api/vote/${e.token}`).expect(200)).body;
    expect(page.voterState).toBe('already_voted');
    expect(page.progress).toEqual({ voted: 3, total: 3 });
    expect((await me.get('/api/vote').expect(200)).body.campaigns[0].voterState).toBe('already_voted');
  });

  it('a greyed-out block cannot be voted again: 409, with the same or another candidate, and its ballot is not served', async () => {
    const e = await started();
    const me = await login(app, S1);
    await voteIn(me, e, 0, 0).expect(201);
    expect((await voteIn(me, e, 0, 0).expect(409)).body.code).toBe('already_voted');
    expect((await voteIn(me, e, 0, 2).expect(409)).body.code).toBe('already_voted');
    expect((await me.post(`/api/vote/${e.token}`).send({ candidateId: cand(e, 0, 1) }).expect(409)).body.code).toBe('already_voted');       // the old route too
    expect((await me.post(`/api/vote/${e.token}`).send({ candidateId: cand(e, 0, 1), positionId: e.positions[0].id }).expect(409)).body.code).toBe('already_voted');
    expect((await me.get(`/api/vote/${e.token}/positions/${e.positions[0].id}`).expect(409)).body.code).toBe('already_voted');
    expect(await tally(e)).toMatchObject({ Alice: 1, Bob: 0, Chipo: 0 });
    expect(await receipts(e)).toBe(1);
    await voteIn(me, e, 1, 0).expect(201);                                                                                            // the other blocks are still open
  });

  it('refuses a candidate that is not in the position (400) without using up the position', async () => {
    const e = await started();
    const me = await login(app, S1);
    await voteIn(me, e, 0, 0).expect(201);
    const wrong = await me.post(`/api/vote/${e.token}/positions/${e.positions[1].id}`).send({ candidateId: cand(e, 0, 1) }).expect(400);   // a Press Secretary candidate in Finance Officer
    expect(wrong.body.code).toBe('invalid_candidate');
    await me.post(`/api/vote/${e.token}`).send({ candidateId: cand(e, 1, 0), positionId: e.positions[2].id }).expect(400);
    await me.post(`/api/vote/${e.token}/positions/${e.positions[1].id}`).send({ candidateId: cand(e, 1, 0), extra: 1 }).expect(400);
    await me.post(`/api/vote/${e.token}/positions/${e.positions[1].id}`).send({ candidateId: 'nope' }).expect(400);
    expect(await receipts(e)).toBe(1);
    await voteIn(me, e, 1, 0).expect(201);                                                                                            // still available
  });

  it('abstain is per position and counts as that position\'s vote', async () => {
    const e = await started({ abstain: true });
    const me = await login(app, S1);
    const ballot = (await me.get(`/api/vote/${e.token}/positions/${e.positions[1].id}`).expect(200)).body;
    expect(ballot.candidates.map((c: { name: string }) => c.name)).toEqual(['Dana', 'Esau', 'Abstain (none of the above)']);
    const abstain = ballot.candidates.find((c: { isAbstain: boolean }) => c.isAbstain);
    await me.post(`/api/vote/${e.token}/positions/${e.positions[1].id}`).send({ candidateId: abstain.id }).expect(201);
    await voteIn(me, e, 1, 0).expect(409);                                                                                            // abstaining used up this position
    await voteIn(me, e, 0, 0).expect(201);                                                                                            // the others are untouched
    expect((await ownerDb().query('SELECT count(*)::int AS n FROM candidates WHERE campaign_id = $1 AND is_abstain', [e.id])).rows[0].n).toBe(3);   // one line per position
  });

  it('a withdrawn candidate stays on their position\'s ballot, greyed, and cannot be chosen', async () => {
    const e = await started();
    await e.admin.post(`/api/campaigns/${e.id}/candidates/${cand(e, 0, 2)}/withdraw`).send({ reason: 'Moved to another office' }).expect(200);
    const me = await login(app, S1);
    const ballot = (await me.get(`/api/vote/${e.token}/positions/${e.positions[0].id}`).expect(200)).body;
    expect(ballot.candidates.find((c: { name: string }) => c.name === 'Chipo').withdrawn).toBe(true);
    expect((await voteIn(me, e, 0, 2).expect(409)).body.code).toBe('candidate_withdrawn');
    expect(await receipts(e)).toBe(0);
    // each position keeps its own "at least 2 in the running"
    await e.admin.post(`/api/campaigns/${e.id}/candidates/${cand(e, 0, 1)}/withdraw`).send({ reason: 'Also moved offices' }).expect(409);
    await e.admin.post(`/api/campaigns/${e.id}/candidates/${cand(e, 1, 0)}/withdraw`).send({ reason: 'Leaving the company' }).expect(409);
  });

  it('turnout counts members who voted in at least one position, and each position has its own turnout', async () => {
    const e = await started();
    const [s1, s2, s3] = await Promise.all([S1, S2, S3].map((u) => login(app, u)));
    await voteIn(s1, e, 0, 0).expect(201); await voteIn(s1, e, 1, 0).expect(201); await voteIn(s1, e, 2, 0).expect(201);
    await voteIn(s2, e, 0, 1).expect(201);
    await voteIn(s3, e, 2, 1).expect(201);
    const open = (await e.admin.get(`/api/campaigns/${e.id}/results`).expect(200)).body;
    expect(open.candidates).toBeNull();                                                                                               // no counts while open
    expect(open.turnout.votes).toBe(3);                                                                                               // three members, not five receipts
    expect(open.positions.map((p: { title: string; turnout: { votes: number } }) => [p.title, p.turnout.votes])).toEqual([['Press Secretary', 2], ['Finance Officer', 1], ['Treasurer', 2]]);
    expect(open.positions.every((p: { candidates: unknown }) => p.candidates === null)).toBe(true);
    expect((await e.admin.get(`/api/campaigns/${e.id}`).expect(200)).body.turnout).toBe(3);
    const list = (await e.admin.get('/api/campaigns/mine').expect(200)).body.campaigns[0];
    expect(list.turnout).toBe(3);
  });
});

describe('one vote per position per member, even in a race', () => {
  it('the same account sending many votes at once for one position gets exactly one receipt and one count', async () => {
    const e = await started();
    const me = await login(app, S1);
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => voteIn(me, e, 0, i % 3)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(19);
    expect(rs.every((r) => r.status === 201 || r.status === 409)).toBe(true);
    expect(await receipts(e)).toBe(1);
    expect(Object.values(await tally(e)).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('simultaneous votes in different positions both succeed; repeats of each fail; the books balance per position', async () => {
    const e = await started();
    const me = await login(app, S2);
    const rs = await Promise.all([voteIn(me, e, 0, 0), voteIn(me, e, 1, 1), voteIn(me, e, 2, 0), voteIn(me, e, 0, 1), voteIn(me, e, 1, 0), voteIn(me, e, 2, 1)]);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(3);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(3);
    const per = (await ownerDb().query(
      `SELECT p.title, (SELECT count(*)::int FROM vote_receipts r WHERE r.position_id = p.id) AS receipts, coalesce((SELECT sum(t.votes)::int FROM tallies t WHERE t.position_id = p.id), 0) AS counted
         FROM positions p WHERE p.campaign_id = $1`, [e.id])).rows;
    for (const p of per) expect([p.title, p.receipts, p.counted]).toEqual([p.title, 1, 1]);
  });

  it('many voters at once across all positions: every count is exact', async () => {
    const e = await started();
    const users = [S1, S2, S3, S4, S5];
    const sessions = await Promise.all(users.map((u) => login(app, u)));
    const jobs = sessions.flatMap((s, i) => [voteIn(s, e, 0, i % 3), voteIn(s, e, 1, i % 2), voteIn(s, e, 2, (i + 1) % 2), voteIn(s, e, 0, 0)]);
    const rs = await Promise.all(jobs);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(15);
    expect(await receipts(e)).toBe(15);
    expect(Object.values(await tally(e)).reduce((a, b) => a + b, 0)).toBe(15);
  });

  it('two accounts of one Umoja member share their vote per position (SEC-03 per position), but each position can still be voted once', async () => {
    await setMembers([['NAM0101', true], ['NAM0102', true]]);
    const e = await started({ eligibility: 'umoja' });
    const first = await login(app, { ...S1, employeeCode: 'NAM0101' });
    const second = await login(app, { ...S2, employeeCode: 'NAM0101' });
    await voteIn(first, e, 0, 0).expect(201);
    expect((await voteIn(second, e, 0, 1).expect(409)).body.code).toBe('already_voted');          // same member, same position
    const page = (await second.get(`/api/vote/${e.token}`).expect(200)).body;
    expect(page.positions[0].voted).toBe(true);                                                    // the second account sees the block as done too
    expect(page.progress.voted).toBe(1);
    await voteIn(second, e, 1, 0).expect(201);                                                     // but the member's other positions are still theirs to vote
    expect(await receipts(e)).toBe(2);
    expect((await ownerDb().query('SELECT count(DISTINCT member_key)::int AS n FROM vote_receipts WHERE campaign_id = $1', [e.id])).rows[0].n).toBe(1);
    // the database enforces it too
    await expect(ownerDb().query('INSERT INTO vote_receipts (campaign_id, position_id, voter_oid, member_key) VALUES ($1, $2, $3, $4)', [e.id, e.positions[0].id, S3.oid, 'code:NAM0101'])).rejects.toThrow(/vote_receipts_member_unique/);
  });
});

describe('secrecy across positions', () => {
  it('no table links a member to a candidate: receipts hold no candidate and no time, counters hold no member', async () => {
    const cols = async (t: string) => (await ownerDb().query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name", [t])).rows.map((r) => r.column_name as string);
    expect(await cols('vote_receipts')).toEqual(['campaign_id', 'member_key', 'position_id', 'voter_oid']);
    expect(await cols('tallies')).toEqual(['campaign_id', 'candidate_id', 'position_id', 'votes']);
    // every table that has a candidate column must have no column that names a member or account
    const withCandidate = (await ownerDb().query("SELECT DISTINCT table_name FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'candidate_id'")).rows.map((r) => r.table_name as string);
    expect(withCandidate.sort()).toEqual(['tallies']);
    for (const t of withCandidate) for (const c of await cols(t)) expect(c).not.toMatch(/voter|member|oid|email|user/);
  });

  it('after voting in all positions: no row anywhere holds both a voter identifier and a candidate id, and no receipt shares its xmin with a counter', async () => {
    const e = await started({ abstain: true });
    const users = [S1, S2, S3];
    for (const [i, u] of users.entries()) {
      const s = await login(app, u);
      await voteIn(s, e, 0, i % 3).expect(201); await voteIn(s, e, 1, i % 2).expect(201); await voteIn(s, e, 2, (i + 1) % 2).expect(201);
    }
    const candidateIds = (await ownerDb().query('SELECT id FROM candidates WHERE campaign_id = $1', [e.id])).rows.map((r) => r.id as string);
    const voterIds = [...users.flatMap((u) => [u.oid, u.email]), ...(await ownerDb().query('SELECT member_key FROM vote_receipts')).rows.map((r) => r.member_key as string)];
    const tables = (await ownerDb().query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).rows.map((r) => r.table_name as string);
    let checkedRows = 0;
    for (const t of tables) {
      for (const row of (await ownerDb().query(`SELECT * FROM "${t}"`)).rows) {
        const text = JSON.stringify(row);
        checkedRows++;
        expect(voterIds.some((v) => text.includes(v)) && candidateIds.some((c) => text.includes(c)), `${t} links a voter to a candidate: ${text.slice(0, 160)}`).toBe(false);
      }
    }
    expect(checkedRows).toBeGreaterThan(50);
    // the hidden transaction id: all counters carry one re-stamped id, and no receipt (one per position per voter, each its own transaction) matches it
    const t = await ownerDb().query('SELECT DISTINCT xmin::text AS x FROM tallies WHERE campaign_id = $1', [e.id]);
    expect(t.rowCount).toBe(1);
    const r = (await ownerDb().query('SELECT xmin::text AS x FROM vote_receipts WHERE campaign_id = $1', [e.id])).rows.map((x) => x.x);
    expect(r).toHaveLength(9);
    expect(r).not.toContain(t.rows[0].x);
    // and the audit log has no vote entries at all
    expect((await ownerDb().query("SELECT count(*)::int AS n FROM audit_log WHERE campaign_id = $1 AND action ILIKE '%vote%'", [e.id])).rows[0].n).toBe(0);
  });

  it('no API response in a multi-position walk mixes a voter identifier with a candidate id', async () => {
    responseLog.length = 0;
    const e = await started();
    const voters = [S1, S2, S3];
    for (const [i, u] of voters.entries()) {
      const s = await login(app, u);
      await s.get('/api/vote').expect(200);
      await s.get(`/api/vote/${e.token}`).expect(200);
      for (let p = 0; p < 3; p++) {
        await s.get(`/api/vote/${e.token}/positions/${e.positions[p].id}`).expect(200);
        await voteIn(s, e, p, i % 2).expect(201);
        await voteIn(s, e, p, 0).expect(409);
        await s.get(`/api/vote/${e.token}/positions/${e.positions[p].id}`).expect(409);
        await s.get(`/api/vote/${e.token}`).expect(200);
      }
    }
    await e.admin.get(`/api/campaigns/${e.id}`).expect(200);
    await e.admin.get(`/api/campaigns/${e.id}/results`).expect(200);
    await e.admin.get(`/api/campaigns/${e.id}/positions`).expect(200);
    await e.admin.post(`/api/campaigns/${e.id}/close`).expect(200);
    await e.admin.post(`/api/campaigns/${e.id}/publish`).expect(200);
    await e.admin.get(`/api/campaigns/${e.id}/results`).expect(200);
    await e.admin.get(`/api/campaigns/${e.id}/results.csv`).expect(200);
    await (await login(app, S1)).get(`/api/vote/${e.token}/results`).expect(200);
    const all = e.positions.flatMap((p) => p.candidates.map((c) => c.id));
    const voterIds = voters.flatMap((u) => [u.oid, u.email]);
    expect(responseLog.length).toBeGreaterThan(60);
    expect(responseLog.some((r) => all.some((id) => r.body.includes(id)))).toBe(true);
    expect(responseLog.some((r) => voterIds.some((id) => r.body.includes(id)))).toBe(true);
    for (const r of responseLog) {
      expect(voterIds.some((id) => r.body.includes(id)) && all.some((id) => r.body.includes(id)), `${r.url} mixes a voter identifier with a candidate id`).toBe(false);
    }
  });
});
