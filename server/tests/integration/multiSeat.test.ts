// Multi-position campaigns, the rules that need the server: choose-N is enforced exactly (not just by the UI), a candidate may stand in
// two positions with every count kept apart, the eligibility line is information only, and turnout is per position and never per choice.
// Reference ballot: Secretary (choose 1), Treasurer (choose 1), Additional Members (choose exactly 2).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { ADMIN_A, S1, S2, S3, S4, closeOwner, login, makeElection, ownerDb, resetDb, type Election } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

type Sess = Awaited<ReturnType<typeof login>>;
const MEMBERS = 2;   // index of the Additional Members position

async function committee(extra: Partial<Parameters<typeof makeElection>[1]> = {}): Promise<Election & { admin: Sess }> {
  const admin = await login(app, ADMIN_A);
  const e = await makeElection(admin, {
    abstain: true, start: true,
    positions: [
      { title: 'Secretary', candidates: ['Alice', 'Bob', 'Chipo'] },
      { title: 'Treasurer', candidates: ['Dana', 'Esau', 'Fiona', 'Gideon'] },
      { title: 'Additional Members', seats: 2, candidates: ['Hanna', 'Ivan', 'Jo', 'Kay', 'Lee'] },
    ],
    ...extra,
  });
  return { ...e, admin };
}
const ids = (e: Election, p: number, ...i: number[]) => i.map((x) => e.positions[p].candidates[x].id);
const abstainOf = async (e: Election, p: number) => (await ownerDb().query('SELECT id FROM candidates WHERE position_id = $1 AND is_abstain', [e.positions[p].id])).rows[0].id as string;
const post = (s: Sess, e: Election, p: number, body: object) => s.post(`/api/vote/${e.token}/positions/${e.positions[p].id}`).send(body);
const receipts = async (e: Election, p: number) => (await ownerDb().query('SELECT count(*)::int AS n FROM vote_receipts WHERE position_id = $1', [e.positions[p].id])).rows[0].n as number;
const counters = async (e: Election, p: number) => Object.fromEntries((await ownerDb().query(
  'SELECT k.name, t.votes FROM tallies t JOIN candidates k ON k.id = t.candidate_id WHERE t.position_id = $1', [e.positions[p].id])).rows.map((r) => [r.name as string, r.votes as number]));
const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);

describe('choose-N is enforced by the server, exactly', () => {
  it('refuses too few, too many, repeats, abstain mixed in, foreign candidates and a malformed body, and writes NOTHING for any of them', async () => {
    const e = await committee();
    const me = await login(app, S1);
    const abst = await abstainOf(e, MEMBERS);
    const other = e.positions[0].candidates[0].id;   // a candidate of another position
    const bad: [string, object, number, string?][] = [
      ['one of two', { candidateIds: ids(e, MEMBERS, 0) }, 400, 'wrong_number'],
      ['a single candidateId on a two-seat position', { candidateId: e.positions[MEMBERS].candidates[0].id }, 400, 'wrong_number'],
      ['three of two', { candidateIds: ids(e, MEMBERS, 0, 1, 2) }, 400, 'wrong_number'],
      ['the same candidate twice', { candidateIds: ids(e, MEMBERS, 0, 0) }, 400, 'duplicate_candidate'],
      ['a candidate and abstain', { candidateIds: [...ids(e, MEMBERS, 0), abst] }, 400, 'abstain_mixed'],
      ['one candidate of another position', { candidateIds: [...ids(e, MEMBERS, 0), other] }, 400, 'invalid_candidate'],
      ['an unknown candidate', { candidateIds: [...ids(e, MEMBERS, 0), '00000000-0000-4000-8000-000000000000'] }, 400, 'invalid_candidate'],
      ['an empty list', { candidateIds: [] }, 400],
      ['both candidateId and candidateIds', { candidateId: ids(e, MEMBERS, 0)[0], candidateIds: ids(e, MEMBERS, 0, 1) }, 400],
      ['neither', {}, 400],
      ['an extra field', { candidateIds: ids(e, MEMBERS, 0, 1), positionId: e.positions[MEMBERS].id }, 400],
    ];
    for (const [what, body, status, code] of bad) {
      const r = await post(me, e, MEMBERS, body);
      expect(r.status, what).toBe(status);
      if (code) expect(r.body.code, what).toBe(code);
    }
    // a one-seat position refuses two picks too
    const r = await post(me, e, 0, { candidateIds: ids(e, 0, 0, 1) });
    expect([r.status, r.body.code]).toEqual([400, 'wrong_number']);

    expect(await receipts(e, MEMBERS)).toBe(0);
    expect(await receipts(e, 0)).toBe(0);
    expect(total(await counters(e, MEMBERS))).toBe(0);
    expect(total(await counters(e, 0))).toBe(0);
    // none of that used up the voter's one vote
    await post(me, e, MEMBERS, { candidateIds: ids(e, MEMBERS, 0, 1) }).expect(201);
  });

  it('exactly N picks make ONE receipt and one vote for each pick; a second ballot is refused and changes nothing', async () => {
    const e = await committee();
    const me = await login(app, S1);
    const res = await post(me, e, MEMBERS, { candidateIds: ids(e, MEMBERS, 0, 1) }).expect(201);
    expect(res.body.receiptCode).toMatch(/^UV-/);
    expect(await receipts(e, MEMBERS)).toBe(1);
    expect(await counters(e, MEMBERS)).toMatchObject({ Hanna: 1, Ivan: 1, Jo: 0, Kay: 0, Lee: 0 });
    const again = await post(me, e, MEMBERS, { candidateIds: ids(e, MEMBERS, 2, 3) });
    expect([again.status, again.body.code]).toEqual([409, 'already_voted']);
    expect(await receipts(e, MEMBERS)).toBe(1);
    expect(total(await counters(e, MEMBERS))).toBe(2);
  });

  it('the legacy route takes the same list, and the one-seat positions are unchanged (one candidateId, or a list of one)', async () => {
    const e = await committee();
    const a = await login(app, S1), b = await login(app, S2);
    await a.post(`/api/vote/${e.token}`).send({ candidateIds: ids(e, MEMBERS, 3, 4), positionId: e.positions[MEMBERS].id }).expect(201);
    expect(await counters(e, MEMBERS)).toMatchObject({ Kay: 1, Lee: 1 });
    await post(a, e, 0, { candidateId: ids(e, 0, 0)[0] }).expect(201);
    await post(b, e, 0, { candidateIds: ids(e, 0, 1) }).expect(201);
    expect(await counters(e, 0)).toMatchObject({ Alice: 1, Bob: 1, Chipo: 0 });
  });

  it('abstaining abstains from every seat: one receipt, and the Abstain line takes one vote per seat, so counters stay receipts x seats', async () => {
    const e = await committee();
    const me = await login(app, S1);
    await post(me, e, MEMBERS, { candidateIds: [await abstainOf(e, MEMBERS)] }).expect(201);
    const c = await counters(e, MEMBERS);
    expect(await receipts(e, MEMBERS)).toBe(1);
    expect(c['Abstain (none of the above)']).toBe(2);
    expect(total(c)).toBe(2 * (await receipts(e, MEMBERS)));
  });

  it('two simultaneous ballots from one voter: exactly one wins, and the counters hold exactly one ballot', async () => {
    const e = await committee();
    const me = await login(app, S1);
    const rs = await Promise.all([post(me, e, MEMBERS, { candidateIds: ids(e, MEMBERS, 0, 1) }), post(me, e, MEMBERS, { candidateIds: ids(e, MEMBERS, 2, 3) })]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await receipts(e, MEMBERS)).toBe(1);
    expect(total(await counters(e, MEMBERS))).toBe(2);
  });

  it('closing works with choose-N ballots (receipts x seats = counters), counts them per seat, and reports a shared last seat as a tie', async () => {
    const e = await committee();
    const [a, b, c, d] = await Promise.all([S1, S2, S3, S4].map((u) => login(app, u)));
    await post(a, e, MEMBERS, { candidateIds: ids(e, MEMBERS, 0, 1) }).expect(201);   // Hanna, Ivan
    await post(b, e, MEMBERS, { candidateIds: ids(e, MEMBERS, 0, 2) }).expect(201);   // Hanna, Jo
    await post(c, e, MEMBERS, { candidateIds: [await abstainOf(e, MEMBERS)] }).expect(201);
    await post(d, e, 0, { candidateId: ids(e, 0, 0)[0] }).expect(201);
    await e.admin.post(`/api/campaigns/${e.id}/close`).send({ reason: 'Closing for the test run' }).expect(200);   // not blocked by the integrity check
    const r = (await e.admin.get(`/api/campaigns/${e.id}/results`).expect(200)).body;
    const members = r.positions.find((p: { title: string }) => p.title === 'Additional Members');
    expect(members.turnout.votes).toBe(3);
    expect(members.winners.map((w: { name: string }) => w.name)).toEqual(['Hanna']);
    expect(members.tie.names.sort()).toEqual(['Ivan', 'Jo']);   // one seat left, two candidates level on 1 vote: nobody is given it
    const secretary = r.positions.find((p: { title: string }) => p.title === 'Secretary');
    expect(secretary.winners.map((w: { name: string }) => w.name)).toEqual(['Alice']);
  });

  it('the integrity check still catches a counter that was tampered with on a choose-N position', async () => {
    const e = await committee();
    await post(await login(app, S1), e, MEMBERS, { candidateIds: ids(e, MEMBERS, 0, 1) }).expect(201);
    await ownerDb().query('ALTER TABLE tallies DISABLE TRIGGER USER');
    try { await ownerDb().query("UPDATE tallies SET votes = votes + 1 WHERE candidate_id = $1", [e.positions[MEMBERS].candidates[4].id]); }
    finally { await ownerDb().query('ALTER TABLE tallies ENABLE TRIGGER USER'); }
    const r = await e.admin.post(`/api/campaigns/${e.id}/close`).send({ reason: 'Closing for the test run' });
    expect([r.status, r.body.code]).toEqual([409, 'integrity_mismatch']);
  });
});

describe('the same person in two positions', () => {
  it('is allowed: a candidate is entered once per position, and every count and winner is per position', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, {
      start: true,
      positions: [{ title: 'Secretary', candidates: ['Alice Amutenya', 'Bob Basson'] }, { title: 'Treasurer', candidates: ['Alice Amutenya', 'Cy Cloete'] }],
    });
    // two separate candidate rows, one per position
    const alices = (await ownerDb().query("SELECT id, position_id FROM candidates WHERE campaign_id = $1 AND name = 'Alice Amutenya'", [e.id])).rows;
    expect(alices).toHaveLength(2);
    expect(new Set(alices.map((a) => a.position_id)).size).toBe(2);
    expect(new Set(alices.map((a) => a.id)).size).toBe(2);

    const [s1, s2, s3] = await Promise.all([S1, S2, S3].map((u) => login(app, u)));
    // Secretary: Alice 2, Bob 1.   Treasurer: Alice 1, Cy 2.
    for (const [s, sec, tre] of [[s1, 0, 0], [s2, 0, 1], [s3, 1, 1]] as [Sess, number, number][]) {
      await post(s, e, 0, { candidateId: e.positions[0].candidates[sec].id }).expect(201);
      await post(s, e, 1, { candidateId: e.positions[1].candidates[tre].id }).expect(201);
    }
    expect(await counters(e, 0)).toEqual({ 'Alice Amutenya': 2, 'Bob Basson': 1 });
    expect(await counters(e, 1)).toEqual({ 'Alice Amutenya': 1, 'Cy Cloete': 2 });
    await admin.post(`/api/campaigns/${e.id}/close`).send({ reason: 'Closing for the test run' }).expect(200);
    const r = (await admin.get(`/api/campaigns/${e.id}/results`).expect(200)).body;
    const win = (title: string) => r.positions.find((p: { title: string }) => p.title === title).winners.map((w: { name: string; votes: number }) => `${w.name}:${w.votes}`);
    expect(win('Secretary')).toEqual(['Alice Amutenya:2']);
    expect(win('Treasurer')).toEqual(['Cy Cloete:2']);   // Alice wins one position and loses the other: nothing is re-allocated or merged
  });

  it('a vote for the Secretary Alice cannot be cast into the Treasurer position', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { start: true, positions: [{ title: 'Secretary', candidates: ['Alice', 'Bob'] }, { title: 'Treasurer', candidates: ['Alice', 'Cy'] }] });
    const r = await post(await login(app, S1), e, 1, { candidateId: e.positions[0].candidates[0].id });
    expect([r.status, r.body.code]).toEqual([400, 'invalid_candidate']);
    expect(await receipts(e, 1)).toBe(0);
  });
});

describe('the eligibility line (rule_text)', () => {
  it('is saved with a position, shown to voters on the home and ballot, limited to 200 characters, and never decides who may vote', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'Additional Members', seats: 2, ruleText: 'Must be from the HR Department', candidates: ['A', 'B', 'C'] }] });
    const pid = e.positions[0].id;
    expect((await admin.get(`/api/campaigns/${e.id}/positions`).expect(200)).body.positions[0]).toMatchObject({ rule_text: 'Must be from the HR Department', seats: 2 });
    await admin.patch(`/api/campaigns/${e.id}/positions/${pid}`).send({ rule_text: 'Must be from the Finance Department' }).expect(200);
    await admin.patch(`/api/campaigns/${e.id}/positions/${pid}`).send({ rule_text: 'x'.repeat(201) }).expect(400);
    await admin.patch(`/api/campaigns/${e.id}/positions/${pid}`).send({ rule_text: null }).expect(200);
    await admin.patch(`/api/campaigns/${e.id}/positions/${pid}`).send({ rule_text: 'Must be from the HR Department' }).expect(200);
    await admin.post(`/api/campaigns/${e.id}/start`).expect(200);

    const me = await login(app, S1);   // not an HR person, as far as the system knows: it does not matter
    const home = (await me.get(`/api/vote/${e.token}`).expect(200)).body;
    expect(home.positions[0]).toMatchObject({ ruleText: 'Must be from the HR Department', seats: 2 });
    const ballot = (await me.get(`/api/vote/${e.token}/positions/${pid}`).expect(200)).body;
    expect(ballot.position).toMatchObject({ ruleText: 'Must be from the HR Department', seats: 2 });
    await post(me, e, 0, { candidateIds: ids(e, 0, 0, 1) }).expect(201);
  });

  it('is empty (null) when none was set', async () => {
    const e = await committee();
    const home = (await (await login(app, S1)).get(`/api/vote/${e.token}`).expect(200)).body;
    expect(home.positions.map((p: { ruleText: unknown }) => p.ruleText)).toEqual([null, null, null]);
  });
});

describe('live turnout per position', () => {
  it('while the campaign is open the admin sees how many voted in each position and no candidate counts at all', async () => {
    const e = await committee();
    const [a, b] = await Promise.all([S1, S2].map((u) => login(app, u)));
    await post(a, e, MEMBERS, { candidateIds: ids(e, MEMBERS, 0, 1) }).expect(201);
    await post(b, e, MEMBERS, { candidateIds: ids(e, MEMBERS, 2, 3) }).expect(201);
    await post(a, e, 0, { candidateId: ids(e, 0, 0)[0] }).expect(201);
    const body = (await e.admin.get(`/api/campaigns/${e.id}/results`).expect(200)).body;
    expect(body.candidates).toBeNull();
    const t = Object.fromEntries(body.positions.map((p: { title: string; turnout: { votes: number }; candidates: unknown }) => [p.title, p.turnout.votes]));
    expect(t).toEqual({ Secretary: 1, Treasurer: 0, 'Additional Members': 2 });
    for (const p of body.positions) expect(p.candidates).toBeNull();
    const text = JSON.stringify(body);
    for (const name of ['Hanna', 'Ivan', 'Alice']) expect(text).not.toContain(name);   // no candidate names, so no counts to go with them
    expect(text).not.toMatch(/"votes":\s*[1-9]\d*,"(name|id)"/);
  });
});
