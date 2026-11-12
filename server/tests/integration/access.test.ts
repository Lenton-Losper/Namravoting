import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Test } from 'supertest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { ADMIN_A, ADMIN_B, S1, S2, anonymous, closeOwner, login, ownerDb, png, resetDb, type Session } from '../helpers.js';

/**
 * Access-control matrix. For EVERY admin and voter route:
 *   - a different admin / an unrelated staff user / an anonymous caller is refused (404 / 403 / 401),
 *   - the refusal body contains none of the campaign's data,
 *   - nothing changed in the database,
 *   - and (positive control) the rightful user gets success in the same test, so "refused" can't mean "broken".
 */
const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

const TITLE = 'Confidential Title Zulu';
type Stage = 'draft' | 'open' | 'closed' | 'published';
interface Fx { id: string; token: string; cands: string[]; photoCand: string; cleanup: string[] }

/** A campaign with 2 candidates (one with a photo), eligibility list = [S1], advanced to the requested stage. */
async function fixture(admin: Session, stage: Stage): Promise<Fx> {
  const c = (await admin.post('/api/campaigns').send({ title: TITLE, description: 'Secret description Yankee' }).expect(201)).body;
  const withPhoto = (await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', 'Alpha Person').field('bio', 'bio alpha')
    .attach('photo', await png(200, 200), { filename: 'a.png', contentType: 'image/png' }).expect(201)).body;
  const plain = (await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', 'Bravo Person').expect(201)).body;
  await admin.put(`/api/campaigns/${c.id}/eligible`).send({ mode: 'list', emails: [S1.email] }).expect(200);
  if (stage !== 'draft') await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
  if (stage === 'closed' || stage === 'published') await admin.post(`/api/campaigns/${c.id}/close`).expect(200);
  if (stage === 'published') await admin.post(`/api/campaigns/${c.id}/publish`).expect(200);
  return { id: c.id, token: c.share_token, cands: [withPhoto.id, plain.id], photoCand: withPhoto.id, cleanup: [] };
}

const snapshot = async (id: string) => JSON.stringify({
  campaign: (await ownerDb().query('SELECT * FROM campaigns WHERE id = $1', [id])).rows,
  candidates: (await ownerDb().query('SELECT * FROM candidates WHERE campaign_id = $1 ORDER BY id', [id])).rows,
  eligible: (await ownerDb().query('SELECT * FROM eligible_voters WHERE campaign_id = $1 ORDER BY voter_email', [id])).rows,
  receipts: (await ownerDb().query('SELECT * FROM vote_receipts WHERE campaign_id = $1', [id])).rows,
  tallies: (await ownerDb().query('SELECT * FROM tallies WHERE campaign_id = $1 ORDER BY candidate_id', [id])).rows,
});

const leakTerms = (f: Fx) => [f.id, f.token, TITLE, 'Secret description Yankee', 'Alpha Person', 'Bravo Person', 'bio alpha', ...f.cands];
function expectNoLeak(res: { text: string }, f: Fx, label: string) {
  const text = res.text ?? '';
  for (const t of leakTerms(f)) expect(text.includes(t), `${label} leaked "${t}"`).toBe(false);
}

interface AdminRoute { name: string; stage: Stage; call: (s: Session, f: Fx) => Test; control: number; staff?: number }
const adminRoutes: AdminRoute[] = [
  { name: 'GET /campaigns/:id', stage: 'draft', call: (s, f) => s.get(`/api/campaigns/${f.id}`), control: 200 },
  { name: 'PATCH /campaigns/:id', stage: 'draft', call: (s, f) => s.patch(`/api/campaigns/${f.id}`).send({ title: 'Changed' }), control: 200 },
  { name: 'POST /campaigns/:id/candidates', stage: 'draft', call: (s, f) => s.post(`/api/campaigns/${f.id}/candidates`).field('name', 'New'), control: 201 },
  { name: 'PATCH /campaigns/:id/candidates/:cid', stage: 'draft', call: (s, f) => s.patch(`/api/campaigns/${f.id}/candidates/${f.cands[1]}`).field('name', 'Renamed'), control: 200 },
  { name: 'DELETE /campaigns/:id/candidates/:cid', stage: 'draft', call: (s, f) => s.del(`/api/campaigns/${f.id}/candidates/${f.cands[1]}`), control: 204 },
  { name: 'PUT /campaigns/:id/eligible', stage: 'draft', call: (s, f) => s.put(`/api/campaigns/${f.id}/eligible`).send({ mode: 'all' }), control: 200 },
  { name: 'POST /campaigns/:id/start', stage: 'draft', call: (s, f) => s.post(`/api/campaigns/${f.id}/start`), control: 200 },
  { name: 'POST /campaigns/:id/close', stage: 'open', call: (s, f) => s.post(`/api/campaigns/${f.id}/close`), control: 200 },
  { name: 'GET /campaigns/:id/results', stage: 'open', call: (s, f) => s.get(`/api/campaigns/${f.id}/results`), control: 200 },
  { name: 'POST /campaigns/:id/publish', stage: 'closed', call: (s, f) => s.post(`/api/campaigns/${f.id}/publish`), control: 200 },
  { name: 'GET /campaigns/:id/qr.png', stage: 'open', call: (s, f) => s.get(`/api/campaigns/${f.id}/qr.png`), control: 200 },
  { name: 'GET /campaigns/:id/qr.png?download=1', stage: 'open', call: (s, f) => s.get(`/api/campaigns/${f.id}/qr.png?download=1`), control: 200 },
  { name: 'GET /campaigns/:id/poster.pdf', stage: 'open', call: (s, f) => s.get(`/api/campaigns/${f.id}/poster.pdf`), control: 200 },
  { name: 'GET /campaigns/:id/results.csv', stage: 'closed', call: (s, f) => s.get(`/api/campaigns/${f.id}/results.csv`), control: 200 },
  { name: 'GET /campaigns/:id/results.xlsx', stage: 'closed', call: (s, f) => s.get(`/api/campaigns/${f.id}/results.xlsx`), control: 200 },
  { name: 'GET /campaigns/:id/results.pdf', stage: 'closed', call: (s, f) => s.get(`/api/campaigns/${f.id}/results.pdf`), control: 200 },
  // Photos: not an admin-only route, but creator-scoped while the campaign is a draft. Staff get 404 (not 403).
  { name: 'GET /photos/:cid (draft)', stage: 'draft', call: (s, f) => s.get(`/api/photos/${f.photoCand}`), control: 200, staff: 404 },
];

describe('admin routes: nobody but the creator gets anything', () => {
  it.each(adminRoutes)('$name', async (route) => {
    const owner = await login(app, ADMIN_A);
    const otherAdmin = await login(app, ADMIN_B);
    const staff = await login(app, S2);
    const anon = await anonymous(app);
    const f = await fixture(owner, route.stage);
    const before = await snapshot(f.id);

    const asOther = await route.call(otherAdmin, f);
    expect(asOther.status, 'other admin').toBe(404);
    expectNoLeak(asOther, f, 'other admin');

    const asStaff = await route.call(staff, f);
    expect(asStaff.status, 'plain staff').toBe(route.staff ?? 403);
    expectNoLeak(asStaff, f, 'plain staff');

    const asAnon = await route.call(anon, f);
    expect(asAnon.status, 'anonymous').toBe(401);
    expectNoLeak(asAnon, f, 'anonymous');

    expect(await snapshot(f.id), 'refused calls must not change anything').toBe(before);

    const rightful = await route.call(owner, f);                      // POSITIVE CONTROL
    expect(rightful.status, `rightful creator: ${rightful.text?.slice(0, 200)}`).toBe(route.control);
  });
});

describe('admin list routes only ever return the caller\'s own campaigns', () => {
  it('GET /campaigns/mine and /campaigns/summary: B sees nothing of A; A sees own (control); staff refused', async () => {
    const a = await login(app, ADMIN_A);
    const b = await login(app, ADMIN_B);
    const staff = await login(app, S2);
    const f = await fixture(a, 'open');
    const closed = await fixture(a, 'closed');

    for (const url of ['/api/campaigns/mine', '/api/campaigns/summary']) {
      const asB = await b.get(url).expect(200);
      expectNoLeak(asB, f, `B ${url}`);
      expectNoLeak(asB, closed, `B ${url}`);
      const asA = await a.get(url).expect(200);                      // POSITIVE CONTROL
      expect(asA.text).toContain(f.id);
      await staff.get(url).expect(403);
      await (await anonymous(app)).get(url).expect(401);
    }
  });

  it('POST /campaigns creates for the caller only; staff refused', async () => {
    const a = await login(app, ADMIN_A);
    const staff = await login(app, S2);
    await staff.post('/api/campaigns').send({ title: 'nope' }).expect(403);
    await (await anonymous(app)).post('/api/campaigns').send({ title: 'nope' }).expect(401);
    const made = (await a.post('/api/campaigns').send({ title: 'mine' }).expect(201)).body;      // control
    const owner = await ownerDb().query('SELECT created_by FROM campaigns WHERE id = $1', [made.id]);
    expect(owner.rows[0].created_by).toBe(ADMIN_A.oid);
    expect((await ownerDb().query('SELECT 1 FROM campaigns')).rowCount).toBe(1);                 // the refused ones created nothing
  });
});

interface VoterRoute { name: string; stage: Stage; call: (s: Session, f: Fx) => Test; control: number; refused: number }
const voterRoutes: VoterRoute[] = [
  { name: 'GET /vote/:token', stage: 'open', call: (s, f) => s.get(`/api/vote/${f.token}`), control: 200, refused: 403 },
  { name: 'POST /vote/:token', stage: 'open', call: (s, f) => s.post(`/api/vote/${f.token}`).send({ candidateId: f.cands[0] }), control: 201, refused: 403 },
  { name: 'GET /vote/:token/results', stage: 'published', call: (s, f) => s.get(`/api/vote/${f.token}/results`), control: 200, refused: 403 },
  { name: 'GET /photos/:cid (open campaign)', stage: 'open', call: (s, f) => s.get(`/api/photos/${f.photoCand}`), control: 200, refused: 404 },
];

describe('voter routes: ineligible users get nothing', () => {
  it.each(voterRoutes)('$name', async (route) => {
    const admin = await login(app, ADMIN_A);
    const eligible = await login(app, S1);          // on the list
    const ineligible = await login(app, S2);        // signed in, NOT on the list
    const anon = await anonymous(app);
    const f = await fixture(admin, route.stage);
    const before = await snapshot(f.id);

    const refused = await route.call(ineligible, f);
    expect(refused.status, 'ineligible staff').toBe(route.refused);
    expectNoLeak(refused, f, 'ineligible staff');

    const asAnon = await route.call(anon, f);
    expect(asAnon.status, 'anonymous').toBe(401);
    expectNoLeak(asAnon, f, 'anonymous');

    // an admin who is not eligible and not the creator (B) is refused the same way
    const otherAdmin = await login(app, ADMIN_B);
    const asB = await route.call(otherAdmin, f);
    expect(asB.status, 'other admin on a voter route').toBe(route.refused);
    expectNoLeak(asB, f, 'other admin');

    expect(await snapshot(f.id), 'refused calls must not change anything').toBe(before);

    const ok = await route.call(eligible, f);                         // POSITIVE CONTROL
    expect(ok.status, `eligible voter: ${ok.text?.slice(0, 200)}`).toBe(route.control);
  });

  it('GET /vote (My votes) lists only what the caller may vote in', async () => {
    const admin = await login(app, ADMIN_A);
    const f = await fixture(admin, 'open');
    const ineligible = await login(app, S2);
    const eligible = await login(app, S1);
    const none = await ineligible.get('/api/vote').expect(200);
    expect(none.body.campaigns).toEqual([]);
    expectNoLeak(none, f, 'ineligible My votes');
    const some = await eligible.get('/api/vote').expect(200);       // POSITIVE CONTROL
    expect(some.body.campaigns).toHaveLength(1);
    expect(some.body.campaigns[0].title).toBe(TITLE);
    await (await anonymous(app)).get('/api/vote').expect(401);
  });

  it('a draft campaign is invisible to voters even with its token (not_open for eligible; photo 404)', async () => {
    const admin = await login(app, ADMIN_A);
    const f = await fixture(admin, 'draft');
    const eligible = await login(app, S1);
    const info = (await eligible.get(`/api/vote/${f.token}`).expect(200)).body;
    expect(info.voterState).toBe('not_open');
    expect(info.candidates).toEqual([]);                             // no candidate names/ids for a draft
    expect((await eligible.get('/api/vote').expect(200)).body.campaigns).toEqual([]);
    await eligible.get(`/api/photos/${f.photoCand}`).expect(404);
    await admin.get(`/api/photos/${f.photoCand}`).expect(200);       // control: creator can
  });
});
