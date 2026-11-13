// "Allow edits after start" and "the eligibility mode chosen at creation is the one saved".
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { ADMIN_A, S1, S2, TEST_APP_URL, closeOwner, count, login, ownerDb, png, resetDb } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); await appRole.end(); });

/** A connection as the restricted runtime role: used to prove the DATABASE refuses, whatever the application does. */
const appRole = new pg.Pool({ connectionString: TEST_APP_URL, max: 2 });

type Admin = Awaited<ReturnType<typeof login>>;

/** Creates a campaign through the API with the given settings and N candidates; optionally starts it. */
async function make(admin: Admin, opts: { allow?: boolean; eligibility?: 'all' | 'umoja' | 'list'; emails?: string[]; n?: number; start?: boolean; closes_at?: string } = {}) {
  const body: Record<string, unknown> = { title: 'Edit test', eligibility: opts.eligibility ?? 'all' };
  if (opts.allow !== undefined) body.allow_edits_after_start = opts.allow;
  if (opts.emails) body.emails = opts.emails;
  if (opts.closes_at) body.closes_at = opts.closes_at;
  const c = (await admin.post('/api/campaigns').send(body).expect(201)).body;
  const candidates: string[] = [];
  for (let i = 0; i < (opts.n ?? 2); i++) candidates.push((await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', `Candidate ${i + 1}`).expect(201)).body.id);
  if (opts.start) await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
  return { id: c.id as string, token: c.share_token as string, candidates };
}
const editAudits = async (id: string) =>
  (await ownerDb().query("SELECT details, actor_oid FROM audit_log WHERE campaign_id = $1 AND action = 'campaign.edit_after_start' ORDER BY seq", [id])).rows;

describe('the eligibility mode chosen when creating a campaign is the mode saved', () => {
  it('"All staff" is saved as all (it used to come back as Umoja-only)', async () => {
    const admin = await login(app, ADMIN_A);
    const c = (await admin.post('/api/campaigns').send({ title: 'All staff vote', eligibility: 'all' }).expect(201)).body;
    expect(c.eligibility).toBe('all');
    expect((await admin.get(`/api/campaigns/${c.id}`).expect(200)).body.eligibility).toBe('all');
    expect((await ownerDb().query('SELECT eligibility FROM campaigns WHERE id = $1', [c.id])).rows[0].eligibility).toBe('all');
    const audit = (await ownerDb().query("SELECT details FROM audit_log WHERE campaign_id = $1 AND action = 'campaign.create'", [c.id])).rows[0].details;
    expect(audit).toMatchObject({ eligibility: 'all', allow_edits_after_start: false });
  });

  it('leaving it out still means Umoja members only (the documented default)', async () => {
    const admin = await login(app, ADMIN_A);
    const c = (await admin.post('/api/campaigns').send({ title: 'Default' }).expect(201)).body;
    expect(c.eligibility).toBe('umoja');
  });

  it('a listed vote saves its email list with the campaign, and rejects bad or missing lists', async () => {
    const admin = await login(app, ADMIN_A);
    const c = (await admin.post('/api/campaigns').send({ title: 'List', eligibility: 'list', emails: ['A@namra.org.na', 'a@namra.org.na', 'b@namra.org.na'] }).expect(201)).body;
    expect(c.eligibility).toBe('list');
    expect((await admin.get(`/api/campaigns/${c.id}`)).body.eligible_emails).toEqual(['a@namra.org.na', 'b@namra.org.na']);
    await admin.post('/api/campaigns').send({ title: 'x', eligibility: 'list' }).expect(400);
    await admin.post('/api/campaigns').send({ title: 'x', eligibility: 'list', emails: ['not an email'] }).expect(400);
    await admin.post('/api/campaigns').send({ title: 'x', eligibility: 'all', emails: ['a@namra.org.na'] }).expect(400);
    await admin.post('/api/campaigns').send({ title: 'x', eligibility: 'bogus' }).expect(400);
    expect((await ownerDb().query("SELECT count(*)::int AS n FROM campaigns WHERE title = 'x'")).rows[0].n).toBe(0);   // nothing half-created
  });

  it('a campaign created as "all" lets any signed-in member vote', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { eligibility: 'all', start: true });
    const s1 = await login(app, S1);
    await s1.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
  });
});

describe('allow edits after start: off by default', () => {
  it('default off: starting locks title, description, closing time and candidates, exactly as before', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { start: true, n: 3 });
    expect((await admin.get(`/api/campaigns/${c.id}`)).body.allow_edits_after_start).toBe(false);
    await admin.patch(`/api/campaigns/${c.id}`).send({ title: 'Changed' }).expect(409);
    await admin.patch(`/api/campaigns/${c.id}`).send({ closes_at: new Date(Date.now() + 3600_000).toISOString() }).expect(409);
    await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', 'Late').expect(409);
    await admin.patch(`/api/campaigns/${c.id}/candidates/${c.candidates[0]}`).field('name', 'Renamed').expect(409);
    await admin.del(`/api/campaigns/${c.id}/candidates/${c.candidates[0]}`).expect(409);
    expect(await editAudits(c.id)).toHaveLength(0);
  });

  it('the setting itself can be toggled while the campaign is a draft, and is frozen at start', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { allow: false });
    expect((await admin.patch(`/api/campaigns/${c.id}`).send({ allow_edits_after_start: true }).expect(200)).body.allow_edits_after_start).toBe(true);
    expect((await admin.patch(`/api/campaigns/${c.id}`).send({ allow_edits_after_start: false }).expect(200)).body.allow_edits_after_start).toBe(false);
    await admin.patch(`/api/campaigns/${c.id}`).send({ allow_edits_after_start: true }).expect(200);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    await admin.patch(`/api/campaigns/${c.id}`).send({ allow_edits_after_start: false }).expect(409);
  });
});

describe('allow edits after start: title, description, closing time', () => {
  it('can be edited while open; each edit writes an audit entry and shows as "Edited after start" with its time', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { allow: true, start: true });
    const closes = new Date(Date.now() + 2 * 3600_000).toISOString();
    const r = await admin.patch(`/api/campaigns/${c.id}`).send({ title: 'Better title', description: 'More detail', closes_at: closes }).expect(200);
    expect(r.body).toMatchObject({ title: 'Better title', description: 'More detail', status: 'open' });
    const audits = await editAudits(c.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].actor_oid).toBe(ADMIN_A.oid);
    expect(audits[0].details.changes.map((x: { what: string }) => x.what).sort()).toEqual(['closes_at', 'description', 'title']);
    expect(audits[0].details.changes.find((x: { what: string }) => x.what === 'title')).toMatchObject({ from: 'Edit test', to: 'Better title' });

    const page = (await admin.get(`/api/campaigns/${c.id}`)).body;       // the campaign page
    expect(page.edited_after_start).toHaveLength(1);
    expect(page.edited_after_start[0]).toMatchObject({ kind: 'edited_after_start' });
    expect(new Date(page.edited_after_start[0].at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    const results = (await admin.get(`/api/campaigns/${c.id}/results`)).body;
    expect(results.notices.map((n: { kind: string }) => n.kind)).toContain('edited_after_start');
    const s1 = await login(app, S1);                                     // voters see it on the ballot page
    expect((await s1.get(`/api/vote/${c.token}`).expect(200)).body.notices.map((n: { kind: string }) => n.kind)).toContain('edited_after_start');
  });

  it('a second edit adds a second entry; an edit that changes nothing writes nothing', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { allow: true, start: true });
    await admin.patch(`/api/campaigns/${c.id}`).send({ title: 'Edit test' }).expect(200);          // same title
    expect(await editAudits(c.id)).toHaveLength(0);
    await admin.patch(`/api/campaigns/${c.id}`).send({ title: 'One' }).expect(200);
    await admin.patch(`/api/campaigns/${c.id}`).send({ title: 'Two' }).expect(200);
    expect(await editAudits(c.id)).toHaveLength(2);
  });

  it('the opening time, the eligibility and the setting stay locked after start', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { allow: true, start: true });
    await admin.patch(`/api/campaigns/${c.id}`).send({ opens_at: new Date(Date.now() + 86_400_000).toISOString() }).expect(409);
    await admin.patch(`/api/campaigns/${c.id}`).send({ allow_edits_after_start: false }).expect(409);
    await admin.put(`/api/campaigns/${c.id}/eligible`).send({ mode: 'umoja' }).expect(409);
    await admin.put(`/api/campaigns/${c.id}/eligible`).send({ mode: 'list', emails: ['a@namra.org.na'] }).expect(409);
    expect((await ownerDb().query('SELECT eligibility, opens_at FROM campaigns WHERE id = $1', [c.id])).rows[0]).toMatchObject({ eligibility: 'all', opens_at: null });
    expect(await editAudits(c.id)).toHaveLength(0);
  });

  it('a new closing time must be in the future (by the database clock)', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { allow: true, start: true });
    await admin.patch(`/api/campaigns/${c.id}`).send({ closes_at: new Date(Date.now() - 60_000).toISOString() }).expect(400);
    expect((await admin.patch(`/api/campaigns/${c.id}`).send({ closes_at: null }).expect(200)).body.closes_at).toBeNull();   // open-ended is fine
  });

  it('a closed campaign is locked completely, flag or not', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { allow: true, start: true });
    await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
    await admin.patch(`/api/campaigns/${c.id}`).send({ title: 'Too late' }).expect(409);
    await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', 'Late').expect(409);
  });

  it("only the owner can edit; another admin gets 404 and nothing is written", async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { allow: true, start: true });
    const other = await login(app, { ...ADMIN_A, oid: '00000000-0000-4000-8000-0000000000b2', email: 'other.admin@namra.org.na' });
    await other.patch(`/api/campaigns/${c.id}`).send({ title: 'Hijacked' }).expect(404);
    expect((await ownerDb().query('SELECT title FROM campaigns WHERE id = $1', [c.id])).rows[0].title).toBe('Edit test');
  });

  it('a published result carries the "Edited after start" entry', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { allow: true, start: true });
    await admin.patch(`/api/campaigns/${c.id}`).send({ title: 'Renamed in flight' }).expect(200);
    const s1 = await login(app, S1);
    await s1.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
    await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
    await admin.post(`/api/campaigns/${c.id}/publish`).expect(200);
    const pub = (await s1.get(`/api/vote/${c.token}/results`).expect(200)).body;
    const e = pub.notices.find((n: { kind: string }) => n.kind === 'edited_after_start');
    expect(e.changes[0]).toMatchObject({ what: 'title', to: 'Renamed in flight' });
    expect(e.at).toBeTruthy();
  });
});

describe('allow edits after start: candidates until the first vote', () => {
  it('can be added, edited and removed before any vote; every change is audited and the ballot follows', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { allow: true, start: true, n: 2 });
    const added = (await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', 'Late Starter').field('bio', 'joined').attach('photo', await png(), 'p.png').expect(201)).body;
    await admin.patch(`/api/campaigns/${c.id}/candidates/${c.candidates[0]}`).field('name', 'Renamed One').expect(200);
    await admin.del(`/api/campaigns/${c.id}/candidates/${c.candidates[1]}`).expect(204);

    const s1 = await login(app, S1);
    const ballot = (await s1.get(`/api/vote/${c.token}`).expect(200)).body.candidates.map((x: { name: string }) => x.name).sort();
    expect(ballot).toEqual(['Late Starter', 'Renamed One']);
    // a counter exists for the new candidate, none for the removed one, and the integrity check still balances
    const tallies = (await ownerDb().query('SELECT candidate_id, votes FROM tallies WHERE campaign_id = $1', [c.id])).rows;
    expect(tallies.map((t) => t.candidate_id).sort()).toEqual([c.candidates[0], added.id].sort());
    expect(tallies.every((t) => t.votes === 0)).toBe(true);
    await s1.post(`/api/vote/${c.token}`).send({ candidateId: added.id }).expect(201);
    expect((await ownerDb().query('SELECT votes FROM tallies WHERE candidate_id = $1', [added.id])).rows[0].votes).toBe(1);
    expect(await count('ballots', c.id)).toBe(await count('vote_receipts', c.id));

    const changes = (await editAudits(c.id)).flatMap((a) => a.details.changes as { what: string; name?: string; from?: string; to?: string }[]);
    expect(changes.map((x) => x.what)).toEqual(['candidate_added', 'candidate_edited', 'candidate_removed']);
    expect(changes[0].name).toBe('Late Starter');
    expect(changes[1]).toMatchObject({ name: 'Renamed One', from: 'Candidate 1', to: 'Renamed One' });
    expect(changes[2].name).toBe('Candidate 2');
  });

  it('after the FIRST VOTE the candidates are locked: add, edit and remove are all refused', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { allow: true, start: true, n: 3 });
    const s1 = await login(app, S1);
    await s1.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
    const add = await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', 'Too Late').expect(409);
    expect(add.body.code).toBe('votes_cast');
    await admin.patch(`/api/campaigns/${c.id}/candidates/${c.candidates[1]}`).field('name', 'Nope').expect(409);
    await admin.del(`/api/campaigns/${c.id}/candidates/${c.candidates[2]}`).expect(409);
    expect((await ownerDb().query('SELECT count(*)::int AS n FROM candidates WHERE campaign_id = $1', [c.id])).rows[0].n).toBe(3);
    expect(await editAudits(c.id)).toHaveLength(0);
    // title and closing time are still editable after the first vote (only candidates lock)
    await admin.patch(`/api/campaigns/${c.id}`).send({ title: 'Still editable' }).expect(200);
  });

  it('removal cannot leave a running vote with fewer than 2 candidates', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { allow: true, start: true, n: 2 });
    const r = await admin.del(`/api/campaigns/${c.id}/candidates/${c.candidates[0]}`).expect(409);
    expect(r.body.code).toBe('needs_candidates');
  });

  it('a reset (votes cleared) re-opens candidate editing, and the edit is still audited', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { allow: true, start: true, n: 3 });
    const s1 = await login(app, S1);
    await s1.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
    await admin.post(`/api/campaigns/${c.id}/reset`).send({ confirm_title: 'Edit test', reason: 'Wrong candidate listed' }).expect(200);
    await admin.del(`/api/campaigns/${c.id}/candidates/${c.candidates[2]}`).expect(204);
    expect(await editAudits(c.id)).toHaveLength(1);
  });

  it('candidates of a campaign created WITHOUT the setting stay locked after start', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { allow: false, start: true, n: 3 });
    const r = await admin.del(`/api/campaigns/${c.id}/candidates/${c.candidates[0]}`).expect(409);
    expect(r.body.code).toBe('locked');
  });
});

describe('the database enforces the same limits, whatever the application does (migration 012)', () => {
  it('as the app role: without the flag an open campaign cannot be edited', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { allow: false, start: true });
    await expect(appRole.query('UPDATE campaigns SET title = $2 WHERE id = $1', [c.id, 'sneaky'])).rejects.toThrow(/locked/);
    await expect(appRole.query("UPDATE campaigns SET closes_at = now() + interval '1 day' WHERE id = $1", [c.id])).rejects.toThrow(/locked/);
    await expect(appRole.query("INSERT INTO candidates (campaign_id, position_id, name, sort_order) VALUES ($1, (SELECT id FROM positions WHERE campaign_id = $1 LIMIT 1), 'x', 99)", [c.id])).rejects.toThrow(/locked/);
  });

  it('as the app role: with the flag, only title, description and closing time can change; never the opening time, eligibility or the flag', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { allow: true, start: true });
    await appRole.query("UPDATE campaigns SET title = 'ok', description = 'ok', closes_at = now() + interval '1 day' WHERE id = $1", [c.id]);
    await expect(appRole.query("UPDATE campaigns SET opens_at = now() WHERE id = $1", [c.id])).rejects.toThrow(/locked/);
    await expect(appRole.query("UPDATE campaigns SET eligibility = 'list' WHERE id = $1", [c.id])).rejects.toThrow(/locked/);
    await expect(appRole.query("UPDATE campaigns SET allow_edits_after_start = false WHERE id = $1", [c.id])).rejects.toThrow(/locked/);
  });

  it('as the app role: candidate changes stop at the first receipt, even with the flag', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { allow: true, start: true, n: 3 });
    await appRole.query("INSERT INTO candidates (campaign_id, position_id, name, sort_order) VALUES ($1, (SELECT id FROM positions WHERE campaign_id = $1 LIMIT 1), 'before', 99)", [c.id]);   // no receipt yet: allowed
    const s1 = await login(app, S1);
    await s1.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
    await expect(appRole.query("INSERT INTO candidates (campaign_id, position_id, name, sort_order) VALUES ($1, (SELECT id FROM positions WHERE campaign_id = $1 LIMIT 1), 'after', 100)", [c.id])).rejects.toThrow(/locked/);
    await expect(appRole.query("UPDATE candidates SET name = 'x' WHERE id = $1", [c.candidates[1]])).rejects.toThrow(/locked/);
    await expect(appRole.query('DELETE FROM candidates WHERE id = $1', [c.candidates[1]])).rejects.toThrow(/locked/);
  });

  it('a closed campaign is locked for the app role whatever the flag says', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { allow: true, start: true });
    await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
    await expect(appRole.query("UPDATE campaigns SET title = 'x' WHERE id = $1", [c.id])).rejects.toThrow(/locked/);
    await expect(appRole.query("INSERT INTO candidates (campaign_id, position_id, name, sort_order) VALUES ($1, (SELECT id FROM positions WHERE campaign_id = $1 LIMIT 1), 'x', 99)", [c.id])).rejects.toThrow(/locked/);
  });
});

describe('a vote and a candidate edit cannot both slip through', () => {
  it('if a vote lands first the edit is refused; the receipt/tally books still balance', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { allow: true, start: true, n: 3 });
    const s1 = await login(app, S1); const s2 = await login(app, S2);
    const [v1, v2, e] = await Promise.all([
      s1.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }),
      s2.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[1] }),
      admin.del(`/api/campaigns/${c.id}/candidates/${c.candidates[2]}`),
    ]);
    expect([v1.status, v2.status]).toEqual([201, 201]);   // removing the third candidate never makes a vote for the others fail
    expect([204, 409]).toContain(e.status);                // either order is legal, but never an edit after a vote
    const cands = (await ownerDb().query('SELECT count(*)::int AS n FROM candidates WHERE campaign_id = $1', [c.id])).rows[0].n;
    expect(cands).toBe(e.status === 204 ? 2 : 3);
    expect(await count('ballots', c.id)).toBe(await count('vote_receipts', c.id));
  });
});
