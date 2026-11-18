// Receipt codes, the results date and the pledge, end to end. The central claim: a receipt code proves that a member voted in a position and
// can NOT be linked to the vote itself: not by its timestamp (there is none), not by row order, not by the code, not by any other table.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { ADMIN_A, S1, S2, S3, S4, S5, closeOwner, login, makeElection, ownerDb, resetDb, responseLog, type Election } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

type Sess = Awaited<ReturnType<typeof login>>;
const FORMAT = /^UV-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/;
const VOTERS = [S1, S2, S3, S4, S5];
/** An extra voter: its own account and NO employee code, so it is its own member (the load test does the same). */
const extra = (i: number, tag = 'v') => ({ oid: `d${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`, email: `${tag}${i}@namra.test`, displayName: `Voter ${i}`, roles: [] as string[], employeeCode: null });

async function started(spec = [{ title: 'Press Secretary', candidates: ['Alice', 'Bob'] }, { title: 'Treasurer', candidates: ['Cy', 'Dee'] }]): Promise<Election & { admin: Sess }> {
  const admin = await login(app, ADMIN_A);
  return { ...(await makeElection(admin, { positions: spec, start: true })), admin };
}
const voteIn = (s: Sess, e: Election, p: number, c: number) => s.post(`/api/vote/${e.token}/positions/${e.positions[p].id}`).send({ candidateId: e.positions[p].candidates[c].id });

describe('the receipt code', () => {
  it('is returned once, when the vote is cast, in the right format, and is stored on the receipt only', async () => {
    const e = await started();
    const me = await login(app, S1);
    const res = await voteIn(me, e, 0, 0).expect(201);
    expect(res.body.recorded).toBe(true);
    expect(res.body.receiptCode).toMatch(FORMAT);
    const rows = (await ownerDb().query('SELECT position_id, receipt_code FROM vote_receipts WHERE campaign_id = $1', [e.id])).rows;
    expect(rows).toEqual([{ position_id: e.positions[0].id, receipt_code: res.body.receiptCode }]);
  });

  it('every vote gets its own code, one per position', async () => {
    const e = await started();
    const codes: string[] = [];
    for (const u of VOTERS) { const s = await login(app, u); codes.push((await voteIn(s, e, 0, 0).expect(201)).body.receiptCode, (await voteIn(s, e, 1, 1).expect(201)).body.receiptCode); }
    expect(new Set(codes).size).toBe(10);
  });

  it('the legacy single-ballot route returns a code too', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'Only', candidates: ['A', 'B'] }], start: true });
    const res = await (await login(app, S1)).post(`/api/vote/${e.token}`).send({ candidateId: e.positions[0].candidates[0].id, positionId: e.positions[0].id }).expect(201);
    expect(res.body.receiptCode).toMatch(FORMAT);
  });

  it('a second vote in the same position is refused and shows no code; the voter sees only their own codes afterwards', async () => {
    const e = await started();
    const me = await login(app, S1); const other = await login(app, S2);
    const first = (await voteIn(me, e, 0, 0).expect(201)).body.receiptCode as string;
    const again = await voteIn(me, e, 0, 1).expect(409);
    expect(JSON.stringify(again.body)).not.toContain(first);
    const theirs = (await voteIn(other, e, 0, 1).expect(201)).body.receiptCode as string;
    const mine = (await me.get(`/api/vote/${e.token}/receipts`).expect(200)).body;
    expect(mine.receipts).toEqual([{ positionId: e.positions[0].id, position: 'Press Secretary', receiptCode: first }]);
    expect(JSON.stringify(mine)).not.toContain(theirs);
    const page = (await me.get(`/api/vote/${e.token}`).expect(200)).body;
    expect(page.positions.map((p: { voted: boolean; receiptCode: string | null }) => [p.voted, p.receiptCode])).toEqual([[true, first], [false, null]]);
    const otherPage = (await other.get(`/api/vote/${e.token}`).expect(200)).body;
    expect(JSON.stringify(otherPage)).not.toContain(first);
  });

  it('a receipt from before migration 020 has no code: null everywhere, no error', async () => {
    const e = await started();
    const me = await login(app, S1);
    await voteIn(me, e, 0, 0).expect(201);
    await ownerDb().query('UPDATE vote_receipts SET receipt_code = NULL WHERE campaign_id = $1', [e.id]);
    expect((await me.get(`/api/vote/${e.token}/receipts`).expect(200)).body.receipts[0].receiptCode).toBeNull();
    expect((await me.get(`/api/vote/${e.token}`).expect(200)).body.positions[0].receiptCode).toBeNull();
  });

  it('the database refuses a malformed or repeated code', async () => {
    const e = await started();
    await voteIn(await login(app, S1), e, 0, 0).expect(201);
    await expect(ownerDb().query("UPDATE vote_receipts SET receipt_code = 'hello' WHERE campaign_id = $1", [e.id])).rejects.toThrow(/receipt_code/);
    await voteIn(await login(app, S2), e, 0, 0).expect(201);
    await expect(ownerDb().query('UPDATE vote_receipts SET receipt_code = (SELECT min(receipt_code) FROM vote_receipts) WHERE campaign_id = $1', [e.id])).rejects.toThrow(/receipt_code_key|unique/i);
  });
});

describe('a receipt cannot be linked to a vote', () => {
  const cols = async (t: string) => (await ownerDb().query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position", [t])).rows as { column_name: string; data_type: string }[];

  it('by timestamp: neither the receipt row nor the counter row has a time of any kind (no timestamp, no serial, no identity)', async () => {
    for (const t of ['vote_receipts', 'tallies']) {
      for (const c of await cols(t)) {
        expect(c.data_type, `${t}.${c.column_name}`).not.toMatch(/timestamp|^date$|^time|interval/);
        expect(c.column_name, `${t}.${c.column_name}`).not.toMatch(/_at$|time|created|updated|seq|serial/);
      }
      const idents = (await ownerDb().query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND (is_identity = 'YES' OR column_default LIKE 'nextval%' OR column_default LIKE '%now()%' OR column_default LIKE '%CURRENT_TIMESTAMP%')", [t])).rows[0].n;
      expect(idents, `${t} has a counter or clock default`).toBe(0);
    }
  });

  it('by row order: receipts are stored in the order people voted, so the order must tell nothing about WHAT was chosen. The same voters voting in the same order but choosing differently leave identical receipt order and different counters', async () => {
    const run = async (choice: (i: number) => number) => {
      const e = await started();
      for (const [i, u] of VOTERS.entries()) await voteIn(await login(app, u), e, 0, choice(i)).expect(201);
      // the receipt rows exactly as a database reader sees them, in physical order, WITHOUT the random code
      const order = (await ownerDb().query('SELECT voter_oid FROM vote_receipts WHERE campaign_id = $1 ORDER BY ctid', [e.id])).rows.map((r) => r.voter_oid as string);
      const tallies = (await ownerDb().query('SELECT k.name, t.votes FROM tallies t JOIN candidates k ON k.id = t.candidate_id WHERE t.position_id = $1 ORDER BY k.name', [e.positions[0].id])).rows;
      return { order, tallies };
    };
    const everyoneAlice = await run(() => 0);
    await resetDb();
    const alternating = await run((i) => i % 2);
    expect(everyoneAlice.order).toEqual(alternating.order);                       // the order is the same whatever was chosen ...
    expect(everyoneAlice.tallies).not.toEqual(alternating.tallies);               // ... although the outcomes differ, so the order cannot encode the choice
    expect(everyoneAlice.tallies).toEqual([{ name: 'Alice', votes: 5 }, { name: 'Bob', votes: 0 }]);
    expect(alternating.tallies).toEqual([{ name: 'Alice', votes: 3 }, { name: 'Bob', votes: 2 }]);
  });

  it('by the code itself: codes do not follow the order of voting, and a voter\'s code says nothing about the candidate they chose', async () => {
    const e = await started([{ title: 'Press Secretary', candidates: ['Alice', 'Bob'] }]);
    const sessions = await Promise.all(Array.from({ length: 12 }, (_, i) => login(app, extra(i))));
    const codes: string[] = [];
    for (const [i, s] of sessions.entries()) codes.push((await voteIn(s, e, 0, i % 2).expect(201)).body.receiptCode);
    expect(codes).not.toEqual([...codes].sort());                                   // not ascending in voting order (chance of a sorted run of 12 random codes: 1 in 479 001 600)
    expect(codes).not.toEqual([...codes].sort().reverse());
    // a code does not contain the candidate, the position, the campaign or the voter
    const secrets = [e.positions[0].candidates[0].id, e.positions[0].candidates[1].id, e.positions[0].id, e.id, 'Alice', 'Bob'].map((x) => x.replace(/-/g, '').slice(0, 8).toUpperCase());
    for (const c of codes) for (const s of secrets) expect(c.replace(/-/g, '')).not.toContain(s);
  });

  it('by any other table or log: a code is on exactly one row of exactly one table, never in the audit log, never in another voter\'s response', async () => {
    const e = await started();
    const mine: string[] = [];
    for (const [i, u] of VOTERS.entries()) { const s = await login(app, u); mine.push((await voteIn(s, e, 0, i % 2).expect(201)).body.receiptCode); }
    const tables = (await ownerDb().query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).rows.map((r) => r.table_name as string);
    for (const code of mine) {
      const where: string[] = [];
      for (const t of tables) {
        const rows = (await ownerDb().query(`SELECT * FROM "${t}"`)).rows;
        const hits = rows.filter((r) => JSON.stringify(r).includes(code)).length;
        if (hits) where.push(`${t}:${hits}`);
      }
      expect(where, `where ${code} is stored`).toEqual(['vote_receipts:1']);
    }
    // and no response seen by anyone else carries it: each code appears only in the response to the vote that made it (and that voter's own pages)
    const seenBy = (code: string) => responseLog.filter((r) => r.body.includes(code)).length;
    for (const code of mine) expect(seenBy(code)).toBeGreaterThanOrEqual(1);
    const stranger = await login(app, extra(99, 'stranger'));
    const before = responseLog.length;
    await stranger.get(`/api/vote/${e.token}`).expect(200); await stranger.get(`/api/vote/${e.token}/receipts`).expect(200);
    for (const r of responseLog.slice(before)) for (const code of mine) expect(r.body.includes(code), `${r.url} shows someone else's code`).toBe(false);
  });

  it('the counters still carry one voter-independent transaction id: no receipt shares its hidden xmin with a counter, with codes in place', async () => {
    const e = await started();
    for (const [i, u] of VOTERS.entries()) await voteIn(await login(app, u), e, 0, i % 2).expect(201);
    const t = await ownerDb().query('SELECT DISTINCT xmin::text AS x FROM tallies WHERE campaign_id = $1', [e.id]);
    expect(t.rowCount).toBe(1);
    const r = (await ownerDb().query('SELECT xmin::text AS x FROM vote_receipts WHERE campaign_id = $1', [e.id])).rows.map((x) => x.x);
    expect(r).toHaveLength(5);
    expect(r).not.toContain(t.rows[0].x);
  });
});

describe('the results date', () => {
  it('is set when the campaign is created, shown to voters, and can be changed or cleared in any state; it never publishes anything', async () => {
    const admin = await login(app, ADMIN_A);
    const c = (await admin.post('/api/campaigns').send({ title: 'T', eligibility: 'all', results_release_at: '2030-01-05T06:00:00.000Z' }).expect(201)).body;
    expect(new Date(c.results_release_at).toISOString()).toBe('2030-01-05T06:00:00.000Z');
    const e = await makeElection(admin, { positions: [{ title: 'P', candidates: ['A', 'B'] }], start: true });
    await admin.patch(`/api/campaigns/${e.id}`).send({ results_release_at: '2030-02-01T06:00:00.000Z' }).expect(200);   // live: still allowed
    const page = (await (await login(app, S1)).get(`/api/vote/${e.token}`).expect(200)).body;
    expect(page.resultsReleaseAt).toBe('2030-02-01T06:00:00.000Z');
    expect(page).not.toHaveProperty('resultsPublished');                                  // voters are never told about results
    await admin.patch(`/api/campaigns/${e.id}`).send({ results_release_at: null }).expect(200);
    expect((await (await login(app, S1)).get(`/api/vote/${e.token}`).expect(200)).body.resultsReleaseAt).toBeNull();
    await admin.patch(`/api/campaigns/${e.id}`).send({ results_release_at: 'next tuesday' }).expect(400);
    expect((await ownerDb().query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'campaign.results_release_set' AND campaign_id = $1", [e.id])).rows[0].n).toBe(2);
  });
});

describe('the candidate pledge', () => {
  it('is saved with a candidate, shown on the ballot, limited to 160 characters, and locked once voting starts', async () => {
    const admin = await login(app, ADMIN_A);
    const c = (await admin.post('/api/campaigns').send({ title: 'T', eligibility: 'all' }).expect(201)).body;
    const pos = (await admin.post(`/api/campaigns/${c.id}/positions`).send({ title: 'P' }).expect(201)).body;
    const cand = (await admin.post(`/api/campaigns/${c.id}/candidates`).field('region', 'Khomas').field('name', 'Alice').field('position_id', pos.id).field('pledge', 'Open books, every quarter.').expect(201)).body;
    expect(cand.pledge).toBe('Open books, every quarter.');
    await admin.post(`/api/campaigns/${c.id}/candidates`).field('region', 'Khomas').field('name', 'Too Long').field('position_id', pos.id).field('pledge', 'x'.repeat(161)).expect(400);
    await admin.post(`/api/campaigns/${c.id}/candidates`).field('region', 'Khomas').field('name', 'Bob').field('position_id', pos.id).expect(201);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const ballot = (await (await login(app, S1)).get(`/api/vote/${c.share_token}/positions/${pos.id}`).expect(200)).body;
    expect(ballot.candidates.find((x: { name: string }) => x.name === 'Alice').pledge).toBe('Open books, every quarter.');
    expect(ballot.candidates.find((x: { name: string }) => x.name === 'Bob').pledge).toBeNull();
    await admin.patch(`/api/campaigns/${c.id}/candidates/${cand.id}`).field('pledge', 'Changed').expect(409);   // candidates lock when voting starts
  });
});
