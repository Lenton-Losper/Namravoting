// Candidate self-nomination: the link, signing in, the profile, review by the admin, and what reaches the ballot.
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { ADMIN_A, S1, S2, S3, S4, anonymous, closeOwner, login, makeElection, ownerDb, png, resetDb, setMembers } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

type Sess = Awaited<ReturnType<typeof login>>;

async function setup(opts: { eligibility?: 'all' | 'umoja' | 'list' } = {}) {
  const admin = await login(app, ADMIN_A);
  const e = await makeElection(admin, { eligibility: opts.eligibility ?? 'all', positions: [{ title: 'Press Secretary', candidates: [] }, { title: 'Finance Officer', candidates: [] }] });
  const invite = async (i: number) => {
    const r = (await admin.post(`/api/campaigns/${e.id}/positions/${e.positions[i].id}/invite`).expect(201)).body;
    return { url: r.invite_url as string, token: (r.invite_url as string).split('/n/')[1] };
  };
  return { admin, e, invite };
}
const submit = (s: Sess, token: string, f: { name?: string; bio?: string; region_id?: string; photo?: Buffer; removePhoto?: boolean }) => {
  let r = s.put(`/api/nominate/${token}`);
  if (f.name !== undefined) r = r.field('name', f.name);
  if (f.bio !== undefined) r = r.field('bio', f.bio);
  if (f.region_id !== undefined) r = r.field('region_id', f.region_id);
  if (f.removePhoto) r = r.field('removePhoto', 'true');
  if (f.photo) r = r.attach('photo', f.photo, { filename: 'me.png', contentType: 'image/png' });
  return r;
};
const rows = async (positionId: string) => (await ownerDb().query('SELECT * FROM candidates WHERE position_id = $1 AND NOT is_abstain ORDER BY sort_order', [positionId])).rows;
const audits = async (id: string, like: string) => (await ownerDb().query('SELECT actor_oid, action, details FROM audit_log WHERE campaign_id = $1 AND action LIKE $2 ORDER BY seq', [id, like])).rows;

describe('the nomination link', () => {
  it('is created per position with a QR code, is the same link when asked again, and is audited', async () => {
    const { admin, e, invite } = await setup();
    const a = await invite(0);
    expect(a.url).toMatch(/\/n\/[A-Za-z0-9_-]{32}$/);
    const again = (await admin.post(`/api/campaigns/${e.id}/positions/${e.positions[0].id}/invite`).expect(201)).body.invite_url;
    expect(again).toBe(a.url);
    const b = await invite(1);
    expect(b.token).not.toBe(a.token);
    const qr = await admin.get(`/api/campaigns/${e.id}/positions/${e.positions[0].id}/invite.png`).expect(200);
    expect(qr.headers['content-type']).toBe('image/png');
    const blocks = (await admin.get(`/api/campaigns/${e.id}/positions`).expect(200)).body.positions;
    expect(blocks[0].nomination_state).toBe('open');
    expect(blocks[0].invite_url).toBe(a.url);
    expect((await audits(e.id, 'nomination.invite')).map((x) => x.details.position_id)).toEqual([e.positions[0].id, e.positions[1].id]);   // once each, not on the repeat
  });

  it('needs a sign-in: an anonymous visitor gets 401 and nothing about the campaign', async () => {
    const { e, invite } = await setup();
    const { token } = await invite(0);
    const anon = await anonymous(app);
    const g = await anon.get(`/api/nominate/${token}`).expect(401);
    expect(JSON.stringify(g.body)).not.toMatch(/Press Secretary|Umoja Committee/);
    await anon.put(`/api/nominate/${token}`).field('name', 'Sneaky').field('region_id', e.regions.Khomas).expect(401);
    await anon.post(`/api/nominate/${token}/withdraw`).expect(401);
    expect(await rows(e.positions[0].id)).toHaveLength(0);
  });

  it('answers unknown and malformed tokens the same way (404), and stops working when revoked', async () => {
    const { admin, e, invite } = await setup();
    const { token } = await invite(0);
    const s = await login(app, S1);
    await s.get('/api/nominate/not-a-token').expect(404);
    await s.get(`/api/nominate/${'A'.repeat(32)}`).expect(404);
    await s.get(`/api/nominate/${token}`).expect(200);
    await admin.del(`/api/campaigns/${e.id}/positions/${e.positions[0].id}/invite`).expect(204);
    await s.get(`/api/nominate/${token}`).expect(404);
    expect((await audits(e.id, 'nomination.invite_revoked'))).toHaveLength(1);
  });
});

describe('the candidate fills in their profile', () => {
  it('sees the position, a pre-filled editable name, the region list and the state; submits with a photo; one profile per person per position', async () => {
    const { admin, e, invite } = await setup();
    const { token } = await invite(0);
    const me = await login(app, S1);
    const info = (await me.get(`/api/nominate/${token}`).expect(200)).body;
    expect(info).toMatchObject({ campaign: { title: 'Umoja Committee 2026' }, position: { title: 'Press Secretary' }, state: 'open', defaultName: S1.displayName, profile: null, canEdit: true });
    expect(info.regions).toHaveLength(14);

    await submit(me, token, { name: S1.displayName, bio: 'Ten years in customs.' }).expect(400);                                  // region is required
    await submit(me, token, { name: 'X', region_id: 'not-a-uuid' }).expect(400);
    await submit(me, token, { name: 'X', region_id: '00000000-0000-4000-8000-000000000000' }).expect(400);                          // not one of this campaign's regions
    const made = await submit(me, token, { name: 'Sam Nomad', bio: 'Ten years in customs.', region_id: e.regions.Erongo, photo: await png() }).expect(201);
    expect(made.body.profile).toMatchObject({ name: 'Sam Nomad', status: 'submitted', regionId: e.regions.Erongo });
    expect(made.body.profile.photoUrl).toMatch(/^\/api\/photos\//);

    // sending again edits the same profile: still one row
    await submit(me, token, { name: 'Samuel Nomad', bio: 'Updated.', region_id: e.regions.Khomas }).expect(200);
    const r = await rows(e.positions[0].id);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: 'Samuel Nomad', bio: 'Updated.', status: 'submitted', submitted_by_oid: S1.oid });
    expect(r[0].photo_path).not.toBeNull();                                                                                          // the photo stays unless replaced or removed
    await submit(me, token, { name: 'Samuel Nomad', region_id: e.regions.Khomas, removePhoto: true }).expect(200);
    expect((await rows(e.positions[0].id))[0].photo_path).toBeNull();

    // the same person can stand for a different position with the other link: their own profile there
    const other = await invite(1);
    await submit(me, other.token, { name: 'Samuel Nomad', region_id: e.regions.Khomas }).expect(201);
    expect(await rows(e.positions[1].id)).toHaveLength(1);

    // the admin sees it in the position block and in the review list, with who submitted it
    const blocks = (await admin.get(`/api/campaigns/${e.id}/positions`).expect(200)).body.positions;
    expect(blocks[0].counts).toMatchObject({ submitted: 1, approved: 0 });
    const list = (await admin.get(`/api/campaigns/${e.id}/positions/${e.positions[0].id}/nominations`).expect(200)).body.nominations;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Samuel Nomad', status: 'submitted', region: 'Khomas', submitted_by: S1.displayName, submitted_by_email: S1.email });
  });

  it('the database also allows only one profile per person per position', async () => {
    const { e, invite } = await setup();
    const { token } = await invite(0);
    await submit(await login(app, S1), token, { name: 'One', region_id: e.regions.Khomas }).expect(201);
    await expect(ownerDb().query("INSERT INTO candidates (campaign_id, position_id, name, status, submitted_by_oid) VALUES ($1, $2, 'Two', 'submitted', $3)", [e.id, e.positions[0].id, S1.oid])).rejects.toThrow(/candidates_one_profile_idx|unique/);
  });

  it('can be edited until the admin approves it; then it is locked for the candidate', async () => {
    const { admin, e, invite } = await setup();
    const { token } = await invite(0);
    const me = await login(app, S1);
    await submit(me, token, { name: 'Sam', region_id: e.regions.Khomas }).expect(201);
    const id = (await rows(e.positions[0].id))[0].id;
    await admin.post(`/api/campaigns/${e.id}/candidates/${id}/approve`).expect(200);
    const locked = await submit(me, token, { name: 'Sam Changed', region_id: e.regions.Khomas }).expect(409);
    expect(locked.body.code).toBe('locked_approved');
    expect((await rows(e.positions[0].id))[0].name).toBe('Sam');
    const info = (await me.get(`/api/nominate/${token}`).expect(200)).body;
    expect(info.profile.status).toBe('approved');
    expect(info.canEdit).toBe(false);
  });

  it('a rejection carries a reason the candidate sees, and they can fix the profile and send it again', async () => {
    const { admin, e, invite } = await setup();
    const { token } = await invite(0);
    const me = await login(app, S1);
    await submit(me, token, { name: 'Sam', bio: 'rude', region_id: e.regions.Khomas }).expect(201);
    const id = (await rows(e.positions[0].id))[0].id;
    await admin.post(`/api/campaigns/${e.id}/candidates/${id}/reject`).send({}).expect(400);                         // a reason is required
    await admin.post(`/api/campaigns/${e.id}/candidates/${id}/reject`).send({ reason: 'abc' }).expect(400);          // and a real one
    await admin.post(`/api/campaigns/${e.id}/candidates/${id}/reject`).send({ reason: 'The bio is not suitable.' }).expect(200);
    const info = (await me.get(`/api/nominate/${token}`).expect(200)).body;
    expect(info.profile).toMatchObject({ status: 'rejected', reviewReason: 'The bio is not suitable.' });
    expect(info.canEdit).toBe(true);
    await submit(me, token, { name: 'Sam', bio: 'Polite now.', region_id: e.regions.Khomas }).expect(200);
    expect((await rows(e.positions[0].id))[0]).toMatchObject({ status: 'submitted', review_reason: null });
    await admin.post(`/api/campaigns/${e.id}/candidates/${id}/reject`).send({ reason: 'Still not right.' }).expect(200);
    await admin.post(`/api/campaigns/${e.id}/candidates/${id}/approve`).expect(200);                                  // the admin can change their mind
    await admin.post(`/api/campaigns/${e.id}/candidates/${id}/approve`).expect(409);                                  // but not approve twice
  });

  it('can be withdrawn by the candidate, and sent again afterwards', async () => {
    const { e, invite } = await setup();
    const { token } = await invite(0);
    const me = await login(app, S1);
    await me.post(`/api/nominate/${token}/withdraw`).expect(404);                                                    // nothing to withdraw yet
    await submit(me, token, { name: 'Sam', region_id: e.regions.Khomas }).expect(201);
    await me.post(`/api/nominate/${token}/withdraw`).expect(200);
    await me.post(`/api/nominate/${token}/withdraw`).expect(409);
    expect((await rows(e.positions[0].id))[0].status).toBe('withdrawn');
    await submit(me, token, { name: 'Sam Again', region_id: e.regions.Khomas }).expect(200);
    expect(await rows(e.positions[0].id)).toHaveLength(1);
    expect((await rows(e.positions[0].id))[0].status).toBe('submitted');
  });

  it('audits every invite, submit, approve, reject and withdraw', async () => {
    const { admin, e, invite } = await setup();
    const { token } = await invite(0);
    const s1 = await login(app, S1); const s2 = await login(app, S2);
    await submit(s1, token, { name: 'One', region_id: e.regions.Khomas }).expect(201);
    await submit(s2, token, { name: 'Two', region_id: e.regions.Erongo }).expect(201);
    const [one, two] = await rows(e.positions[0].id);
    await admin.post(`/api/campaigns/${e.id}/candidates/${one.id}/approve`).expect(200);
    await admin.post(`/api/campaigns/${e.id}/candidates/${two.id}/reject`).send({ reason: 'Not eligible this year.' }).expect(200);
    await s2.post(`/api/nominate/${token}/withdraw`).expect(200);
    const all = (await ownerDb().query("SELECT action, actor_oid, details FROM audit_log WHERE campaign_id = $1 AND action LIKE 'nomination.%' ORDER BY seq", [e.id])).rows;
    expect(all.map((a) => a.action)).toEqual(['nomination.invite', 'nomination.submit', 'nomination.submit', 'nomination.approve', 'nomination.reject', 'nomination.withdraw']);
    expect(all[1].actor_oid).toBe(S1.oid);
    expect(all[3].actor_oid).toBe(ADMIN_A.oid);
    expect(all[4].details.reason).toBe('Not eligible this year.');
  });
});

describe('when nominations close', () => {
  it('they close when the campaign starts: the link answers "closed", a late submit is refused, approvals are locked, and nothing changes', async () => {
    const { admin, e, invite } = await setup();
    const { token } = await invite(0);
    const me = await login(app, S1);
    await submit(me, token, { name: 'Sam', region_id: e.regions.Khomas }).expect(201);
    const id = (await rows(e.positions[0].id))[0].id;
    for (const n of ['A', 'B']) await admin.post(`/api/campaigns/${e.id}/candidates`).field('name', n).field('position_id', e.positions[0].id).expect(201);
    for (const n of ['C', 'D']) await admin.post(`/api/campaigns/${e.id}/candidates`).field('name', n).field('position_id', e.positions[1].id).expect(201);
    await admin.post(`/api/campaigns/${e.id}/start`).expect(200);

    const info = (await me.get(`/api/nominate/${token}`).expect(200)).body;
    expect(info.state).toBe('ended');
    expect(info.canEdit).toBe(false);
    const late = await submit(me, token, { name: 'Sam Late', region_id: e.regions.Khomas }).expect(409);
    expect(late.body.code).toBe('nominations_closed');
    await submit(await login(app, S2), token, { name: 'Newcomer', region_id: e.regions.Khomas }).expect(409);
    await me.post(`/api/nominate/${token}/withdraw`).expect(409);
    await admin.post(`/api/campaigns/${e.id}/candidates/${id}/approve`).expect(409);
    await admin.post(`/api/campaigns/${e.id}/candidates/${id}/reject`).send({ reason: 'Too late to matter.' }).expect(409);
    await expect(ownerDb().query("UPDATE candidates SET name = 'x' WHERE id = $1", [id])).rejects.toThrow(/locked/);
    expect((await rows(e.positions[0].id)).find((r) => r.id === id)).toMatchObject({ name: 'Sam', status: 'submitted' });
    expect((await admin.get(`/api/campaigns/${e.id}/positions`).expect(200)).body.positions[0].nomination_state).toBe('ended');
  });

  it('they close at the optional "nominations close" time', async () => {
    const { admin, e, invite } = await setup();
    const { token } = await invite(0);
    const me = await login(app, S1);
    await admin.patch(`/api/campaigns/${e.id}`).send({ nominations_close_at: new Date(Date.now() + 3600_000).toISOString() }).expect(200);
    await submit(me, token, { name: 'On time', region_id: e.regions.Khomas }).expect(201);
    await ownerDb().query("UPDATE campaigns SET nominations_close_at = now() - interval '1 minute' WHERE id = $1", [e.id]);
    expect((await me.get(`/api/nominate/${token}`).expect(200)).body).toMatchObject({ state: 'expired', canEdit: false });
    expect((await submit(me, token, { name: 'Too late', region_id: e.regions.Khomas }).expect(409)).body.code).toBe('nominations_closed');
    expect((await admin.get(`/api/campaigns/${e.id}/positions`).expect(200)).body.positions[0].nomination_state).toBe('expired');
  });

  it('the admin can close nominations for one position, and open them again', async () => {
    const { admin, e, invite } = await setup();
    const { token } = await invite(0);
    const me = await login(app, S1);
    await admin.patch(`/api/campaigns/${e.id}/positions/${e.positions[0].id}`).send({ status: 'closed' }).expect(200);
    expect((await me.get(`/api/nominate/${token}`).expect(200)).body.state).toBe('closed');
    await submit(me, token, { name: 'Sam', region_id: e.regions.Khomas }).expect(409);
    await admin.patch(`/api/campaigns/${e.id}/positions/${e.positions[0].id}`).send({ status: 'open' }).expect(200);
    await submit(me, token, { name: 'Sam', region_id: e.regions.Khomas }).expect(201);
  });
});

describe('only approved candidates reach the ballot', () => {
  it('a pending, rejected or withdrawn nomination is not on the ballot, has no counter, and its photo is not served to voters', async () => {
    const { admin, e, invite } = await setup();
    const { token } = await invite(0);
    const people = [S1, S2, S3, S4];
    const ids: string[] = [];
    for (const [i, u] of people.entries()) {
      await submit(await login(app, u), token, { name: `Nominee ${i + 1}`, region_id: e.regions.Khomas, photo: await png() }).expect(201);
    }
    for (const r of await rows(e.positions[0].id)) ids.push(r.id);
    await admin.post(`/api/campaigns/${e.id}/candidates/${ids[0]}/approve`).expect(200);
    await admin.post(`/api/campaigns/${e.id}/candidates/${ids[1]}/approve`).expect(200);
    await admin.post(`/api/campaigns/${e.id}/candidates/${ids[2]}/reject`).send({ reason: 'Not a member of staff.' }).expect(200);
    await (await login(app, S4)).post(`/api/nominate/${token}/withdraw`).expect(200);                              // ids[3] withdraws
    for (const n of ['C', 'D']) await admin.post(`/api/campaigns/${e.id}/candidates`).field('name', n).field('position_id', e.positions[1].id).expect(201);
    await admin.post(`/api/campaigns/${e.id}/start`).expect(200);

    const voter = await login(app, (await import('../helpers.js')).ADMIN_B);
    const ballot = (await voter.get(`/api/vote/${e.token}/positions/${e.positions[0].id}`).expect(200)).body;
    expect(ballot.candidates.map((c: { name: string }) => c.name)).toEqual(['Nominee 1', 'Nominee 2']);
    const flat = (await voter.get(`/api/vote/${e.token}`).expect(200)).body;
    expect(flat.candidates.map((c: { name: string }) => c.name)).not.toEqual(expect.arrayContaining(['Nominee 3']));
    expect(flat.positions[0].candidateCount).toBe(2);
    expect((await ownerDb().query('SELECT count(*)::int AS n FROM tallies WHERE position_id = $1', [e.positions[0].id])).rows[0].n).toBe(2);
    // a rejected candidate's photo is not served to a voter; an approved one is
    await voter.get(`/api/photos/${ids[2]}`).expect(404);
    await voter.get(`/api/photos/${ids[0]}`).expect(200);
    // and voting for one of them by id is refused
    await voter.post(`/api/vote/${e.token}/positions/${e.positions[0].id}`).send({ candidateId: ids[2] }).expect(400);
    await voter.post(`/api/vote/${e.token}/positions/${e.positions[0].id}`).send({ candidateId: ids[0] }).expect(201);
  });

  it('a candidate sees their own photo while the campaign is a draft; other staff do not', async () => {
    const { e, invite } = await setup();
    const { token } = await invite(0);
    const me = await login(app, S1);
    await submit(me, token, { name: 'Sam', region_id: e.regions.Khomas, photo: await png() }).expect(201);
    const id = (await rows(e.positions[0].id))[0].id;
    await me.get(`/api/photos/${id}`).expect(200);
    await (await login(app, S2)).get(`/api/photos/${id}`).expect(404);
  });
});

describe('who may nominate', () => {
  it('defaults to the voter eligibility: a listed vote lets only listed staff nominate', async () => {
    const admin = await login(app, ADMIN_A);
    const c = (await admin.post('/api/campaigns').send({ title: 'Listed', eligibility: 'list', emails: [S1.email] }).expect(201)).body;
    const pos = (await admin.post(`/api/campaigns/${c.id}/positions`).send({ title: 'P' }).expect(201)).body.id;
    const token = ((await admin.post(`/api/campaigns/${c.id}/positions/${pos}/invite`).expect(201)).body.invite_url as string).split('/n/')[1];
    const region = (await admin.get(`/api/campaigns/${c.id}/regions`).expect(200)).body.regions[0].id;
    await (await login(app, S1)).get(`/api/nominate/${token}`).expect(200);
    const denied = await (await login(app, S2)).get(`/api/nominate/${token}`).expect(403);
    expect(denied.body.code).toBe('not_eligible');
    await submit(await login(app, S2), token, { name: 'Outsider', region_id: region }).expect(403);
    expect(await rows(pos)).toHaveLength(0);
  });

  it('can be set per campaign: Umoja members only, while the voters are everyone', async () => {
    const { admin, e, invite } = await setup({ eligibility: 'all' });
    const { token } = await invite(0);
    await setMembers([[S1.employeeCode!, true]]);
    await admin.patch(`/api/campaigns/${e.id}`).send({ nominate_eligibility: 'umoja' }).expect(200);
    await (await login(app, S1)).get(`/api/nominate/${token}`).expect(200);
    const no = await (await login(app, S2)).get(`/api/nominate/${token}`).expect(403);
    expect(no.body.code).toBe('not_member');
    await submit(await login(app, S2), token, { name: 'Non member', region_id: e.regions.Khomas }).expect(403);
    await submit(await login(app, S1), token, { name: 'Member', region_id: e.regions.Khomas }).expect(201);
    await admin.patch(`/api/campaigns/${e.id}`).send({ nominate_eligibility: null }).expect(200);                    // back to "same as the voters" (everyone)
    await (await login(app, S2)).get(`/api/nominate/${token}`).expect(200);
  });
});
