// Results privacy, structurally: after the close (and after the winners are announced) NO response that a plain voter can obtain carries counts,
// tallies, turnout, quorum or winners, except the announcement itself (names only, and only for people who voted).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { ADMIN_A, S1, S2, S3, closeOwner, login, makeElection, resetDb } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

/** Keys that mean "a count or a result". Matched anywhere in a response (any depth), except under `announcement`. */
const FORBIDDEN = new Set(['votes', 'votes_cleared', 'tally', 'tallies', 'turnout', 'winners', 'tie', 'tied', 'quorum', 'ballots', 'eligible_count', 'results_published', 'resultsPublished', 'publication']);

function leaks(node: unknown, path = '$'): string[] {
  if (Array.isArray(node)) return node.flatMap((x, i) => leaks(x, `${path}[${i}]`));
  if (node && typeof node === 'object') {
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => {
      if (k === 'announcement') return [];                                                              // the one allowed place (checked separately)
      return [...(FORBIDDEN.has(k) ? [`${path}.${k}`] : []), ...leaks(v, `${path}.${k}`)];
    });
  }
  return [];
}

async function closedWithVotes(announce: boolean) {
  const admin = await login(app, ADMIN_A);
  const e = await makeElection(admin, { start: true, positions: [{ title: 'Chair', candidates: ['Ann', 'Ben', 'Cy'] }, { title: 'Members', seats: 2, candidates: ['Di', 'Eli', 'Fay', 'Gus'] }] });
  const [s1, s2] = await Promise.all([S1, S2].map((u) => login(app, u)));
  const chair = e.positions[0], members = e.positions[1];
  await s1.post(`/api/vote/${e.token}/positions/${chair.id}`).send({ candidateId: chair.candidates[0].id }).expect(201);
  await s2.post(`/api/vote/${e.token}/positions/${chair.id}`).send({ candidateId: chair.candidates[0].id }).expect(201);
  await s1.post(`/api/vote/${e.token}/positions/${members.id}`).send({ candidateIds: [members.candidates[0].id, members.candidates[1].id] }).expect(201);
  await s2.post(`/api/vote/${e.token}/positions/${members.id}`).send({ candidateIds: [members.candidates[0].id, members.candidates[1].id] }).expect(201);   // Di 2, Eli 2: both win (no tie at the cut)
  await admin.post(`/api/campaigns/${e.id}/close`).send({ reason: 'Closing for the test run' }).expect(200);
  if (announce) await admin.post(`/api/campaigns/${e.id}/announce-winners`).expect(201);
  return { admin, e, s1, s2, s3: await login(app, S3) };
}

describe('a voter never receives results or counts', () => {
  it.each([false, true])('after the close (winners announced: %s), every voter-facing GET is free of counts, tallies, turnout and winners', async (announced) => {
    const { e, s1, s3 } = await closedWithVotes(announced);
    for (const s of [s1, s3]) {                                                                          // S1 voted; S3 is eligible and did not
      const urls = ['/api/vote', `/api/vote/${e.token}`, `/api/vote/${e.token}/receipts`, `/api/vote/${e.token}/positions/${e.positions[0].id}`, `/api/vote/${e.token}/positions/${e.positions[1].id}`];
      for (const u of urls) {
        const r = await s.get(u);
        expect(leaks(r.body), `${u} (HTTP ${r.status}) exposes a count or a result`).toEqual([]);
      }
      await s.get(`/api/vote/${e.token}/results`).expect(404);
      for (const gone of [`/api/vote/${e.token}/results.csv`, `/api/vote/${e.token}/tally`, `/api/vote/${e.token}/turnout`]) expect([404, 403]).toContain((await s.get(gone)).status);
    }
  });

  it('admin and observer routes stay closed to a voter', async () => {
    const { e, s1 } = await closedWithVotes(false);
    for (const u of [`/api/campaigns/${e.id}/results`, `/api/campaigns/${e.id}/results.csv`, `/api/campaigns/${e.id}/announcement`, `/api/campaigns/${e.id}/verify`, `/api/observe/${e.id}`]) {
      const r = await s1.get(u);
      expect([403, 404], u).toContain(r.status);
      expect(JSON.stringify(r.body)).not.toMatch(/"votes"|turnout|tallies/);
    }
  });

  it('the announcement is the only result: winners by name, no counts, and only people with a receipt see it', async () => {
    const { s1, s3, e } = await closedWithVotes(true);
    const seen = (await s1.get(`/api/vote/${e.token}`).expect(200)).body.announcement;
    expect(seen.positions[0]).toEqual({ title: 'Chair', winners: ['Ann'] });
    expect(seen.positions[1].title).toBe('Members');
    expect(seen.positions[1].winners).toHaveLength(2);                                                    // choose-2: both seat holders are named
    expect(seen.positions[1].winners).toEqual(['Di', 'Eli']);
    expect(JSON.stringify(seen)).not.toMatch(/\d+ votes?|"votes"|turnout|%|tally/i);
    expect((await s3.get(`/api/vote/${e.token}`).expect(200)).body.announcement).toBeNull();               // no receipt, no announcement
    expect((await s1.get('/api/vote').expect(200)).body.campaigns.find((c: { shareToken: string }) => c.shareToken === e.token)).toMatchObject({ voterState: 'closed' });
  });

  it('My votes lists a closed campaign the voter voted in, as Closed, with their receipt codes and no result flag, until it is archived', async () => {
    const { admin, e, s1, s3 } = await closedWithVotes(false);
    const mine = (await s1.get('/api/vote').expect(200)).body.campaigns.find((c: { shareToken: string }) => c.shareToken === e.token);
    expect(mine).toMatchObject({ voterState: 'closed', positions: { voted: 2, total: 2 } });
    expect(mine.receipts.map((r: { position: string }) => r.position)).toEqual(['Chair', 'Members']);
    for (const r of mine.receipts) expect(r.code).toMatch(/^UV-[23456789A-Z]{4}-[23456789A-Z]{4}$/);
    expect(mine).not.toHaveProperty('resultsPublished');
    expect((await s3.get('/api/vote').expect(200)).body.campaigns.some((c: { shareToken: string }) => c.shareToken === e.token)).toBe(false);   // did not vote: not listed
    await admin.post(`/api/campaigns/${e.id}/archive`).expect(200);
    expect((await s1.get('/api/vote').expect(200)).body.campaigns.some((c: { shareToken: string }) => c.shareToken === e.token)).toBe(false);      // archived: gone
  });

  it('a reset notice reaches voters with its reason but never a count (even while voting is open again)', async () => {
    const { admin, e, s1 } = await closedWithVotes(false);
    await admin.post(`/api/campaigns/${e.id}/reset`).send({ confirm_title: 'Umoja Committee 2026', reason: 'A mistake in the voter list' }).expect(200);
    const info = (await s1.get(`/api/vote/${e.token}`).expect(200)).body;
    const reset = info.notices.find((n: { kind: string }) => n.kind === 'reset');
    expect(reset).toMatchObject({ reason: 'A mistake in the voter list' });
    expect(reset).not.toHaveProperty('votes_cleared'); expect(reset).not.toHaveProperty('candidates');
    expect(leaks(info)).toEqual([]);
  });
});
