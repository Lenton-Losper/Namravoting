// Multi-position campaigns: the position blocks, the start check per position, regions, and the "edit after start" rules.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { ADMIN_A, ADMIN_B, S1, closeOwner, login, makeElection, ownerDb, resetDb } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

const REGIONS = ['Erongo', 'Hardap', '//Kharas', 'Kavango East', 'Kavango West', 'Khomas', 'Kunene', 'Ohangwena', 'Omaheke', 'Omusati', 'Oshana', 'Oshikoto', 'Otjozondjupa', 'Zambezi'];

describe('positions as blocks', () => {
  it('a new campaign has no position yet, the 14 regions of Namibia, and the position blocks start empty', async () => {
    const admin = await login(app, ADMIN_A);
    const c = (await admin.post('/api/campaigns').send({ title: 'Umoja Committee 2026', eligibility: 'all' }).expect(201)).body;
    const detail = (await admin.get(`/api/campaigns/${c.id}`).expect(200)).body;
    expect(detail.positions).toEqual([]);
    expect(detail.regions.map((r: { name: string }) => r.name)).toEqual(REGIONS);
    expect((await admin.get(`/api/campaigns/${c.id}/positions`).expect(200)).body.positions).toEqual([]);
  });

  it('adds, edits, reorders and removes positions while the campaign is a draft; each block shows its approved count and nomination status', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'Press Secretary', candidates: ['A', 'B'] }, { title: 'Finance Officer', candidates: ['C'] }] });
    let blocks = (await admin.get(`/api/campaigns/${e.id}/positions`).expect(200)).body.positions;
    expect(blocks.map((b: { title: string }) => b.title)).toEqual(['Press Secretary', 'Finance Officer']);
    expect(blocks[0].counts.approved).toBe(2);
    expect(blocks[1].counts.approved).toBe(1);
    expect(blocks[0].nomination_state).toBe('not_invited');
    expect(blocks[0].result).toBeNull();                                       // no results before the campaign closes

    const third = (await admin.post(`/api/campaigns/${e.id}/positions`).send({ title: 'Treasurer', description: 'Keeps the books', seats: 2, min_candidates: 3, max_candidates: 5 }).expect(201)).body;
    blocks = third.positions;
    expect(blocks.find((b: { id: string }) => b.id === third.id)).toMatchObject({ seats: 2, min_candidates: 3, max_candidates: 5, required: 3 });

    await admin.patch(`/api/campaigns/${e.id}/positions/${third.id}`).send({ title: 'Treasurer and Auditor', max_candidates: 4 }).expect(200);
    await admin.patch(`/api/campaigns/${e.id}/positions/${third.id}`).send({ min_candidates: 6 }).expect(400);   // max below min

    const order = [third.id, e.positions[1].id, e.positions[0].id];
    blocks = (await admin.post(`/api/campaigns/${e.id}/positions/reorder`).send({ ids: order }).expect(200)).body.positions;
    expect(blocks.map((b: { id: string }) => b.id)).toEqual(order);
    await admin.post(`/api/campaigns/${e.id}/positions/reorder`).send({ ids: [third.id] }).expect(400);             // must list every position once
    await admin.post(`/api/campaigns/${e.id}/positions/reorder`).send({ ids: [third.id, third.id, e.positions[0].id] }).expect(400);

    await admin.del(`/api/campaigns/${e.id}/positions/${e.positions[1].id}`).expect(204);
    expect((await ownerDb().query('SELECT count(*)::int AS n FROM candidates WHERE position_id = $1', [e.positions[1].id])).rows[0].n).toBe(0);   // its candidates go with it
    const audit = (await ownerDb().query("SELECT action FROM audit_log WHERE campaign_id = $1 AND action LIKE 'position.%' ORDER BY seq", [e.id])).rows.map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['position.add', 'position.update', 'position.reorder', 'position.remove']));
  });

  it('a candidate needs a position once the campaign has several; a position of another campaign is refused', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'One', candidates: ['A'] }, { title: 'Two', candidates: ['B'] }] });
    const other = await makeElection(admin, { title: 'Another', positions: [{ title: 'Elsewhere', candidates: ['X'] }] });
    await admin.post(`/api/campaigns/${e.id}/candidates`).field('name', 'No position').expect(400);
    await admin.post(`/api/campaigns/${e.id}/candidates`).field('name', 'Wrong').field('position_id', other.positions[0].id).expect(400);
    await admin.post(`/api/campaigns/${e.id}/candidates`).field('name', 'Wrong region').field('position_id', e.positions[0].id).field('region_id', other.regions.Khomas).expect(400);
  });

  it('a position\'s own maximum is enforced for candidates the admin adds', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'Tiny', candidates: ['A', 'B'], max: 2 }] });
    expect((await admin.post(`/api/campaigns/${e.id}/candidates`).field('name', 'C').field('position_id', e.positions[0].id).expect(409)).body.code).toBe('position_full');
  });

  it('positions are locked once the campaign starts (409, and the database refuses too)', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'P1', candidates: ['A', 'B'] }], start: true });
    await admin.post(`/api/campaigns/${e.id}/positions`).send({ title: 'Late' }).expect(409);
    await admin.patch(`/api/campaigns/${e.id}/positions/${e.positions[0].id}`).send({ title: 'Renamed' }).expect(409);
    await admin.del(`/api/campaigns/${e.id}/positions/${e.positions[0].id}`).expect(409);
    await admin.post(`/api/campaigns/${e.id}/positions/reorder`).send({ ids: [e.positions[0].id] }).expect(409);
    await expect(ownerDb().query("UPDATE positions SET title = 'x' WHERE id = $1", [e.positions[0].id])).rejects.toThrow(/locked/);
    await expect(ownerDb().query("INSERT INTO positions (campaign_id, title) VALUES ($1, 'x')", [e.id])).rejects.toThrow(/locked/);
  });

  it('follows the edit-after-start rules: with the flag only a position\'s title and description change, and it is recorded', async () => {
    const admin = await login(app, ADMIN_A);
    const c = (await admin.post('/api/campaigns').send({ title: 'Flagged', eligibility: 'all', allow_edits_after_start: true }).expect(201)).body;
    const pos = (await admin.post(`/api/campaigns/${c.id}/positions`).send({ title: 'Secretary' }).expect(201)).body.id;
    for (const n of ['A', 'B']) await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', n).field('position_id', pos).expect(201);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    await admin.patch(`/api/campaigns/${c.id}/positions/${pos}`).send({ title: 'General Secretary', description: 'Takes the minutes' }).expect(200);
    await admin.patch(`/api/campaigns/${c.id}/positions/${pos}`).send({ seats: 2 }).expect(409);
    await admin.patch(`/api/campaigns/${c.id}/positions/${pos}`).send({ status: 'closed' }).expect(409);
    await admin.post(`/api/campaigns/${c.id}/positions`).send({ title: 'Added late' }).expect(409);
    await admin.del(`/api/campaigns/${c.id}/positions/${pos}`).expect(409);
    const edit = (await ownerDb().query("SELECT details FROM audit_log WHERE campaign_id = $1 AND action = 'campaign.edit_after_start' ORDER BY seq DESC LIMIT 1", [c.id])).rows[0].details;
    expect(edit.changes.map((x: { what: string }) => x.what)).toEqual(['position_title', 'position_description']);
  });
});

describe('the start check, per position', () => {
  it('refuses a campaign with no position, and names the position that has fewer than 2 approved candidates', async () => {
    const admin = await login(app, ADMIN_A);
    const c = (await admin.post('/api/campaigns').send({ title: 'Empty', eligibility: 'all' }).expect(201)).body;
    const none = await admin.post(`/api/campaigns/${c.id}/start`).expect(409);
    expect(none.body.code).toBe('needs_candidates');
    expect(none.body.error).toMatch(/at least one position/i);

    const e = await makeElection(admin, { positions: [{ title: 'Press Secretary', candidates: ['A', 'B'] }, { title: 'Finance Officer', candidates: ['C'] }] });
    const r = await admin.post(`/api/campaigns/${e.id}/start`).expect(409);
    expect(r.body.code).toBe('needs_candidates');
    expect(r.body.error).toContain('Finance Officer');
    expect(r.body.error).not.toContain('Press Secretary');
    await admin.post(`/api/campaigns/${e.id}/candidates`).field('name', 'D').field('position_id', e.positions[1].id).expect(201);
    await admin.post(`/api/campaigns/${e.id}/start`).expect(200);
  });

  it('uses the position\'s own minimum instead of 2 when it has one', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'Needs three', candidates: ['A', 'B'], min: 3 }] });
    const r = await admin.post(`/api/campaigns/${e.id}/start`).expect(409);
    expect(r.body.error).toMatch(/Needs three: needs at least 3/);
    await admin.post(`/api/campaigns/${e.id}/candidates`).field('name', 'C').field('position_id', e.positions[0].id).expect(201);
    await admin.post(`/api/campaigns/${e.id}/start`).expect(200);
  });

  it('counts only APPROVED candidates (a pending or rejected nomination does not help), and starting creates one counter per approved candidate', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'P', candidates: ['A', 'B'] }] });
    await ownerDb().query("INSERT INTO candidates (campaign_id, position_id, name, status) VALUES ($1, $2, 'Pending', 'submitted'), ($1, $2, 'Rejected', 'rejected')", [e.id, e.positions[0].id]);
    await ownerDb().query("DELETE FROM candidates WHERE id = $1", [e.positions[0].candidates[1].id]);   // leaves only A approved
    expect((await admin.post(`/api/campaigns/${e.id}/start`).expect(409)).body.error).toMatch(/P: needs at least 2 approved candidates \(has 1\)/);
    await admin.post(`/api/campaigns/${e.id}/candidates`).field('name', 'B2').field('position_id', e.positions[0].id).expect(201);
    await admin.post(`/api/campaigns/${e.id}/start`).expect(200);
    const t = (await ownerDb().query('SELECT count(*)::int AS n FROM tallies WHERE campaign_id = $1', [e.id])).rows[0].n;
    expect(t).toBe(2);                                                         // A and B2; the pending and rejected ones have no counter
  });

  it('a position\'s maximum is checked too', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'Capped', candidates: ['A', 'B', 'C'] }] });
    await admin.patch(`/api/campaigns/${e.id}/positions/${e.positions[0].id}`).send({ max_candidates: 2 }).expect(200);
    expect((await admin.post(`/api/campaigns/${e.id}/start`).expect(409)).body.error).toMatch(/Capped: allows at most 2/);
  });
});

describe('regions', () => {
  it('can be renamed, added and removed while the campaign is a draft, with the rules around duplicates and use', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'P', candidates: [{ name: 'A', region: 'Khomas' }, { name: 'B', region: 'Erongo' }] }] });
    const base = `/api/campaigns/${e.id}/regions`;
    await admin.patch(`${base}/${e.regions.Khomas}`).send({ name: 'Windhoek Office' }).expect(200);
    await admin.post(base).send({ name: 'Head Office' }).expect(201);
    expect((await admin.post(base).send({ name: 'head office' }).expect(409)).body.code).toBe('duplicate_region');    // case-insensitive
    expect((await admin.patch(`${base}/${e.regions.Hardap}`).send({ name: 'Erongo' }).expect(409)).body.code).toBe('duplicate_region');
    expect((await admin.del(`${base}/${e.regions.Erongo}`).expect(409)).body.code).toBe('region_in_use');             // a candidate is in it
    await admin.del(`${base}/${e.regions.Hardap}`).expect(204);
    const list = (await admin.get(base).expect(200)).body.regions as { name: string; candidates: number }[];
    expect(list.map((r) => r.name)).not.toContain('Hardap');
    expect(list.find((r) => r.name === 'Windhoek Office')!.candidates).toBe(1);
    expect(list.at(-1)!.name).toBe('Head Office');
    // the renamed region shows on the candidate
    const detail = (await admin.get(`/api/campaigns/${e.id}`).expect(200)).body;
    expect(detail.candidates.find((c: { name: string }) => c.name === 'A').region).toBe('Windhoek Office');
  });

  it('is locked once the campaign starts, and the database refuses a change too', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'P', candidates: ['A', 'B'] }], start: true });
    await admin.post(`/api/campaigns/${e.id}/regions`).send({ name: 'New' }).expect(409);
    await admin.patch(`/api/campaigns/${e.id}/regions/${e.regions.Khomas}`).send({ name: 'x' }).expect(409);
    await admin.del(`/api/campaigns/${e.id}/regions/${e.regions.Khomas}`).expect(409);
    await expect(ownerDb().query("UPDATE regions SET name = 'x' WHERE id = $1", [e.regions.Khomas])).rejects.toThrow(/locked/);
  });

  it('each campaign has its own list (changing one does not touch another)', async () => {
    const admin = await login(app, ADMIN_A);
    const a = await makeElection(admin, { title: 'A', positions: [{ title: 'P', candidates: ['A', 'B'] }] });
    const b = await makeElection(admin, { title: 'B', positions: [{ title: 'P', candidates: ['A', 'B'] }] });
    await admin.patch(`/api/campaigns/${a.id}/regions/${a.regions.Khomas}`).send({ name: 'NamRA Head Office' }).expect(200);
    const names = (await admin.get(`/api/campaigns/${b.id}/regions`).expect(200)).body.regions.map((r: { name: string }) => r.name);
    expect(names).toContain('Khomas');
    expect(names).not.toContain('NamRA Head Office');
  });
});

describe('a one-position campaign built the old way still works', () => {
  it('adding a candidate with no position creates the one default position, named after the campaign', async () => {
    const admin = await login(app, ADMIN_A);
    const c = (await admin.post('/api/campaigns').send({ title: 'Old style vote', eligibility: 'all' }).expect(201)).body;
    await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', 'One').expect(201);
    await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', 'Two').expect(201);
    const pos = (await admin.get(`/api/campaigns/${c.id}/positions`).expect(200)).body.positions;
    expect(pos).toHaveLength(1);
    expect(pos[0].title).toBe('Old style vote');
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const ballot = (await (await login(app, S1)).get(`/api/vote/${c.share_token}`).expect(200)).body;
    expect(ballot.positions).toHaveLength(1);
    expect(ballot.candidates).toHaveLength(2);
  });
});

describe('who can use the new routes', () => {
  it('a second administrator gets 404 on every new route (never 403, never data), and a plain staff member gets 403', async () => {
    const owner = await login(app, ADMIN_A);
    const other = await login(app, ADMIN_B);
    const staff = await login(app, S1);
    const e = await makeElection(owner, { positions: [{ title: 'P', candidates: ['A', 'B'] }] });
    await owner.post(`/api/campaigns/${e.id}/positions/${e.positions[0].id}/invite`).expect(201);
    const nominee = e.positions[0].candidates[0].id;
    const p = `/api/campaigns/${e.id}`;
    const pid = e.positions[0].id;
    const calls: [string, string, Record<string, unknown>?][] = [
      ['get', `${p}/positions`], ['post', `${p}/positions`, { title: 'X' }], ['post', `${p}/positions/reorder`, { ids: [pid] }],
      ['patch', `${p}/positions/${pid}`, { title: 'Y' }], ['del', `${p}/positions/${pid}`],
      ['post', `${p}/positions/${pid}/invite`], ['del', `${p}/positions/${pid}/invite`], ['get', `${p}/positions/${pid}/invite.png`],
      ['get', `${p}/positions/${pid}/nominations`], ['post', `${p}/candidates/${nominee}/approve`], ['post', `${p}/candidates/${nominee}/reject`, { reason: 'No thanks' }],
      ['get', `${p}/regions`], ['post', `${p}/regions`, { name: 'R' }], ['patch', `${p}/regions/${e.regions.Khomas}`, { name: 'K' }], ['del', `${p}/regions/${e.regions.Khomas}`],
      ['put', `${p}/results-view`, { group_by_region: true }],
    ];
    for (const [verb, url, body] of calls) {
      const req = (s: typeof other) => (verb === 'get' ? s.get(url) : verb === 'post' ? s.post(url) : verb === 'patch' ? s.patch(url) : verb === 'put' ? s.put(url) : s.del(url));
      const wrong = await (body ? req(other).send(body) : req(other));
      expect([verb, url, wrong.status]).toEqual([verb, url, 404]);
      expect(JSON.stringify(wrong.body)).not.toMatch(/Press|"A"|invite_url|Khomas/);
      const s = await (body ? req(staff).send(body) : req(staff));
      expect([verb, url, s.status]).toEqual([verb, url, 403]);
    }
    // the owner's data is untouched by all of that
    expect((await owner.get(`${p}/positions`).expect(200)).body.positions).toHaveLength(1);
    expect((await ownerDb().query("SELECT count(*)::int AS n FROM audit_log WHERE campaign_id = $1 AND action = 'authz.denied'", [e.id])).rows[0].n).toBeGreaterThan(0);
  });
});
