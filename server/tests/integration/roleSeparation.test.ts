// Role separation (docs/audit-auth-flow.md, part 2): what a plain voter, a candidate and an admin can reach. No admin data (campaign
// lists, drafts, results, nominations, team) reaches a non-admin, and a nomination page never shows anyone else's profile.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { ADMIN_A, ADMIN_B, S1, S2, S3, closeOwner, login, makeElection, ownerDb, png, resetDb } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

/** A draft with an open nomination link and two submitted (unapproved) profiles, plus an open campaign with a closed sibling. */
async function world() {
  const admin = await login(app, ADMIN_A);
  const draft = await makeElection(admin, { title: 'Secret draft', positions: [{ title: 'Press Secretary', candidates: ['Approved One', 'Approved Two'] }] });
  const invite = (await admin.post(`/api/campaigns/${draft.id}/positions/${draft.positions[0].id}/invite`).expect(201)).body.invite_url as string;
  const token = invite.split('/n/')[1];
  const candidate = await login(app, S1);
  const rival = await login(app, S2);
  await candidate.put(`/api/nominate/${token}`).field('name', 'Cara Candidate').field('bio', 'Cara Candidate bio').field('region_id', draft.regions.Khomas)
    .attach('photo', await png(), { filename: 'c.png', contentType: 'image/png' }).expect(201);
  await rival.put(`/api/nominate/${token}`).field('name', 'Rita Rival').field('bio', 'Rita Rival secret bio').field('region_id', draft.regions.Erongo).attach('photo', await png(), { filename: 'r.png', contentType: 'image/png' }).expect(201);
  const rivalId = (await ownerDb().query("SELECT id FROM candidates WHERE name = 'Rita Rival'")).rows[0].id as string;
  const open = await makeElection(admin, { title: 'Open vote', positions: [{ title: 'Chair', candidates: ['C1', 'C2'] }], start: true });
  const closed = await makeElection(admin, { title: 'Closed vote', positions: [{ title: 'Chair', candidates: ['D1', 'D2'] }], start: true });
  await (await login(app, S3)).post(`/api/vote/${closed.token}/positions/${closed.positions[0].id}`).send({ candidateId: closed.positions[0].candidates[0].id }).expect(201);
  await admin.post(`/api/campaigns/${closed.id}/close`).send({ reason: 'Closing for the role test' }).expect(200);
  return { admin, candidate, rival, voter: await login(app, S3), otherAdmin: await login(app, ADMIN_B), draft, token, rivalId, open, closed };
}

/** Every admin API a campaign has: none of them may answer a non-admin with data. */
const adminRoutes = (id: string, pid: string) => [
  '/api/campaigns/mine', '/api/campaigns/summary', `/api/campaigns/${id}`, `/api/campaigns/${id}/positions`, `/api/campaigns/${id}/regions`,
  `/api/campaigns/${id}/positions/${pid}/nominations`, `/api/campaigns/${id}/positions/${pid}/invite.png`, `/api/campaigns/${id}/results`,
  `/api/campaigns/${id}/verify`, `/api/campaigns/${id}/team`, `/api/campaigns/${id}/notify`, `/api/campaigns/${id}/late-voters`,
  `/api/campaigns/${id}/results.csv`, `/api/campaigns/${id}/results.xlsx`, `/api/campaigns/${id}/results.pdf`, `/api/campaigns/${id}/audit-bundle.zip`,
  `/api/campaigns/${id}/qr.png`, `/api/campaigns/${id}/poster.pdf`,
];

describe('a plain voter and a candidate are not admins', () => {
  it('every admin API answers them 403 or 404, with no campaign data in the body', async () => {
    const w = await world();
    for (const [name, s] of [['voter', w.voter], ['candidate', w.candidate]] as const) {
      for (const url of [...adminRoutes(w.draft.id, w.draft.positions[0].id), ...adminRoutes(w.closed.id, w.closed.positions[0].id)]) {
        const r = await s.get(url);
        expect([name, url, [403, 404].includes(r.status)]).toEqual([name, url, true]);
        expect(JSON.stringify(r.body ?? {})).not.toMatch(/Secret draft|Rita Rival|Cara Candidate|Approved One|D1|share_token|invite_url/);
      }
      // and none of the admin actions
      await s.post(`/api/campaigns/${w.draft.id}/candidates/${w.rivalId}/approve`).expect(403);
      await s.post(`/api/campaigns/${w.draft.id}/start`).expect(403);
      await s.post('/api/campaigns').send({ title: 'x' }).expect(403);
    }
  });

  it('an admin of ANOTHER campaign gets 404 for this campaign\'s admin data (ids are not confirmed)', async () => {
    const w = await world();
    for (const url of adminRoutes(w.draft.id, w.draft.positions[0].id).filter((u) => u.includes(w.draft.id))) {
      expect([url, (await w.otherAdmin.get(url)).status]).toEqual([url, 404]);
    }
    expect((await w.otherAdmin.get('/api/campaigns/mine').expect(200)).body.campaigns).toEqual([]);
  });

  it('My votes lists no drafts, a closed campaign only to people who voted in it, and nobody gets results', async () => {
    const w = await world();
    const list = (await w.voter.get('/api/vote').expect(200)).body.campaigns.map((c: { title: string }) => c.title);
    expect(list).toContain('Open vote');
    expect(list).not.toContain('Secret draft');
    expect(list).toContain('Closed vote');                                  // this voter (S3) voted in it: listed, as Closed
    const other = (await w.candidate.get('/api/vote').expect(200)).body.campaigns.map((c: { title: string }) => c.title);
    expect(other).not.toContain('Closed vote');                             // S1 did not vote in it: not listed
    await w.voter.get(`/api/vote/${w.closed.token}/results`).expect(404);   // a voter has no results route at all
    const draftBallot = (await w.voter.get(`/api/vote/${w.draft.token}`).expect(200)).body;
    expect(draftBallot.positions).toEqual([]);                              // a draft's ballot shows no positions or candidates
    expect(draftBallot.candidates).toEqual([]);
  });
});

describe('a nomination page shows only the person\'s own profile', () => {
  it('a candidate sees their own profile and nothing about any other nominee', async () => {
    const w = await world();
    const mine = (await w.candidate.get(`/api/nominate/${w.token}`).expect(200)).body;
    expect(mine.profile).toMatchObject({ name: 'Cara Candidate', status: 'submitted' });
    expect(JSON.stringify(mine)).not.toMatch(/Rita Rival|Approved One|Approved Two|secret bio/);
    expect(Object.keys(mine).sort()).toEqual(['campaign', 'canEdit', 'closesAt', 'defaultName', 'position', 'profile', 'regions', 'state']);
    // someone who has not applied sees an empty form, never the others
    const fresh = (await w.voter.get(`/api/nominate/${w.token}`).expect(200)).body;
    expect(fresh.profile).toBeNull();
    expect(JSON.stringify(fresh)).not.toMatch(/Rita Rival|Cara Candidate|Approved/);
  });

  it('another nominee\'s unapproved photo is never served to a candidate or a voter (only to its owner and the admins)', async () => {
    const w = await world();
    await w.candidate.get(`/api/photos/${w.rivalId}`).expect(404);
    await w.voter.get(`/api/photos/${w.rivalId}`).expect(404);
    await w.rival.get(`/api/photos/${w.rivalId}`).expect(200);
    await w.admin.get(`/api/photos/${w.rivalId}`).expect(200);
  });

  it('a candidate cannot change or withdraw someone else\'s profile: the API only ever touches the caller\'s own row', async () => {
    const w = await world();
    await w.candidate.post(`/api/nominate/${w.token}/withdraw`).expect(200);
    expect((await ownerDb().query("SELECT status FROM candidates WHERE name = 'Rita Rival'")).rows[0].status).toBe('submitted');
    expect((await ownerDb().query("SELECT status FROM candidates WHERE name = 'Cara Candidate'")).rows[0].status).toBe('withdrawn');
  });
});

describe('the admin', () => {
  it('reaches their own campaign\'s admin data, nominations included', async () => {
    const w = await world();
    const n = (await w.admin.get(`/api/campaigns/${w.draft.id}/positions/${w.draft.positions[0].id}/nominations`).expect(200)).body.nominations;
    expect(n.map((x: { name: string }) => x.name).sort()).toEqual(['Approved One', 'Approved Two', 'Cara Candidate', 'Rita Rival']);
    await w.admin.get(`/api/campaigns/${w.closed.id}/results`).expect(200);
    await w.admin.get(`/api/campaigns/${w.draft.id}/team`).expect(200);
  });
});
