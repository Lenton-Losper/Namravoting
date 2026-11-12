import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import {
  ADMIN_A, ADMIN_B, S1, S2, S3, S4, TEST_APP_URL, closeOwner, count, login, makeCampaign, ownerDb, png, resetDb,
} from '../helpers.js';

const app = createApp();

beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

const ids = async (c: { candidates: string[] }) => c.candidates;

describe('happy path', () => {
  it('create -> 2 candidates -> start -> 3 users vote -> results -> close -> receipts = ballots', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);

    const [a, b] = await ids(c);
    for (const [u, pick] of [[S1, a], [S2, a], [S3, b]] as const) {
      const s = await login(app, u);
      const info = await s.get(`/api/vote/${c.token}`).expect(200);
      expect(info.body.voterState).toBe('can_vote');
      expect(info.body.candidates).toHaveLength(2);
      await s.post(`/api/vote/${c.token}`).send({ candidateId: pick }).expect(201);
    }

    // SEC-01: while the campaign is open even the creator sees turnout only, never per-candidate counts
    const live = (await admin.get(`/api/campaigns/${c.id}/results`).expect(200)).body;
    expect(live.candidates).toBeNull();
    expect(live.turnout.votes).toBe(3);
    expect(JSON.stringify(live)).not.toMatch(/"votes":s*[12].*"name"/);

    const closed = (await admin.post(`/api/campaigns/${c.id}/close`).expect(200)).body;
    const res = (await admin.get(`/api/campaigns/${c.id}/results`).expect(200)).body;
    const votes = Object.fromEntries(res.candidates.map((x: { id: string; votes: number }) => [x.id, x.votes]));
    expect(votes[a]).toBe(2);
    expect(votes[b]).toBe(1);
    expect(res.turnout.votes).toBe(3);

    expect(closed.integrity).toEqual({ ballots: 3, receipts: 3, match: true });
    expect(await count('ballots', c.id)).toBe(await count('vote_receipts', c.id));
    const log = await ownerDb().query("SELECT details FROM audit_log WHERE campaign_id = $1 AND action = 'campaign.close'", [c.id]);
    expect(log.rows[0].details).toMatchObject({ ballots: 3, receipts: 3, match: true });

    // already-voted / closed states, publish, CSV, voter results
    const s1 = await login(app, S1);
    expect((await s1.get(`/api/vote/${c.token}`)).body.voterState).toBe('closed');
    await s1.get(`/api/vote/${c.token}/results`).expect(404);          // not yet published
    const csvBefore = await admin.get(`/api/campaigns/${c.id}/results.csv`).expect(200);
    expect(csvBefore.text).toContain('Candidate 1,2');
    await admin.post(`/api/campaigns/${c.id}/publish`).expect(200);
    const pub = await s1.get(`/api/vote/${c.token}/results`).expect(200);
    expect(pub.body.turnout.votes).toBe(3);
  });

  it('start requires at least 2 candidates; QR and poster render', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 1);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(409);
    await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', 'Second').expect(201);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const qr = await admin.get(`/api/campaigns/${c.id}/qr.png`).expect(200);
    expect(qr.headers['content-type']).toContain('image/png');
    const pdf = await admin.get(`/api/campaigns/${c.id}/poster.pdf`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []; res.on('data', (d: Buffer) => chunks.push(d)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('csv/publish are closed-only', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2);
    await admin.get(`/api/campaigns/${c.id}/results.csv`).expect(409);
    await admin.post(`/api/campaigns/${c.id}/publish`).expect(409);
  });
});

describe('one vote per person', () => {
  it('second vote returns 409', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const s = await login(app, S1);
    await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
    const r = await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[1] }).expect(409);
    expect(r.body.code).toBe('already_voted');
    expect((await s.get(`/api/vote/${c.token}`)).body.voterState).toBe('already_voted');
  });

  it('20 parallel votes by the same user -> exactly 1 receipt and 1 ballot', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const s = await login(app, S1);
    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[i % 2] })),
    );
    const codes = responses.map((r) => r.status);
    expect(codes.filter((x) => x === 201)).toHaveLength(1);
    expect(codes.filter((x) => x === 409)).toHaveLength(19);
    expect(await count('vote_receipts', c.id)).toBe(1);
    expect(await count('ballots', c.id)).toBe(1);
  });

  it('parallel votes by different users all succeed and stay consistent', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const sessions = await Promise.all([S1, S2, S3, S4].map((u) => login(app, u)));
    const rs = await Promise.all(sessions.map((s) => s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] })));
    expect(rs.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(await count('vote_receipts', c.id)).toBe(4);
    expect(await count('ballots', c.id)).toBe(4);
  });
});

describe('load', () => {
  it('40 distinct voters at once: all recorded, receipts = ballots, tally correct', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const sessions = await Promise.all(Array.from({ length: 40 }, (_, i) => login(app, {
      oid: `c${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`, email: `load${i}@namra.test`, displayName: `Load ${i}`, roles: [], employeeCode: null,
    })));
    const rs = await Promise.all(sessions.map((s, i) => s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[i % 4 === 0 ? 1 : 0] })));
    expect(rs.filter((r) => r.status !== 201).map((r) => r.status)).toEqual([]);
    expect(await count('vote_receipts', c.id)).toBe(40);
    expect(await count('ballots', c.id)).toBe(40);
    await admin.post(`/api/campaigns/${c.id}/close`).expect(200);
    const res = (await admin.get(`/api/campaigns/${c.id}/results`)).body;
    expect(res.candidates.map((x: { votes: number }) => x.votes)).toEqual([30, 10]);
  });
});

describe('vote rules', () => {
  it('rejects votes before start (draft) and after close', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2);
    const s = await login(app, S1);
    expect((await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(409)).body.code).toBe('not_open');
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    await admin.post(`/api/campaigns/${c.id}/close`).expect(200);
    expect((await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(409)).body.code).toBe('closed');
    expect(await count('ballots', c.id)).toBe(0);
  });

  it('rejects ineligible voters; allows listed ones (case-insensitive)', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2);
    await admin.put(`/api/campaigns/${c.id}/eligible`).send({ mode: 'list', emails: [S1.email.toUpperCase()] }).expect(200);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const s2 = await login(app, S2);
    const denied = await s2.get(`/api/vote/${c.token}`).expect(403);          // ineligible: no campaign data at all
    expect(denied.body.code).toBe('not_eligible');
    expect(JSON.stringify(denied.body)).not.toContain('Test vote');
    await s2.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(403);
    expect(await count('vote_receipts', c.id)).toBe(0);
    const s1 = await login(app, S1);
    await s1.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
  });

  it('auto-closes lazily when closes_at has passed', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    await ownerDb().query("UPDATE campaigns SET closes_at = now() - interval '1 minute' WHERE id = $1", [c.id]);
    const s = await login(app, S1);
    await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(409);
    const st = await ownerDb().query('SELECT status FROM campaigns WHERE id = $1', [c.id]);
    expect(st.rows[0].status).toBe('closed');
    const a = await ownerDb().query("SELECT details FROM audit_log WHERE campaign_id = $1 AND action = 'campaign.close'", [c.id]);
    expect(a.rows[0].details.reason).toBe('auto');
  });

  it('not_open before opens_at', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2);
    await admin.patch(`/api/campaigns/${c.id}`).send({ opens_at: new Date(Date.now() + 3600_000).toISOString() }).expect(200);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const s = await login(app, S1);
    expect((await s.get(`/api/vote/${c.token}`)).body.voterState).toBe('not_open');
    await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(409);
  });

  it("rejects a candidate from another campaign and saves nothing (receipt rolled back too)", async () => {
    const admin = await login(app, ADMIN_A);
    const c1 = await makeCampaign(admin, 2, 'One');
    const c2 = await makeCampaign(admin, 2, 'Two');
    await admin.post(`/api/campaigns/${c1.id}/start`).expect(200);
    const s = await login(app, S1);
    await s.post(`/api/vote/${c1.token}`).send({ candidateId: c2.candidates[0] }).expect(400);
    expect(await count('vote_receipts', c1.id)).toBe(0);
    expect(await count('ballots', c1.id)).toBe(0);
    // and the voter can still vote properly afterwards
    await s.post(`/api/vote/${c1.token}`).send({ candidateId: c1.candidates[0] }).expect(201);
  });

  it('DB itself rejects a tally row whose candidate belongs to another campaign', async () => {
    const admin = await login(app, ADMIN_A);
    const c1 = await makeCampaign(admin, 2, 'One');
    const c2 = await makeCampaign(admin, 2, 'Two');
    const db = new pg.Client({ connectionString: TEST_APP_URL });
    await db.connect();
    try {
      await expect(db.query('INSERT INTO tallies (campaign_id, candidate_id) VALUES ($1, $2)', [c1.id, c2.candidates[0]])).rejects.toThrow(/foreign key/);
    } finally { await db.end(); }
  });

  it('validates the vote body', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const s = await login(app, S1);
    await s.post(`/api/vote/${c.token}`).send({ candidateId: 'x' }).expect(400);
    await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0], extra: 1 }).expect(400);
    await s.get('/api/vote/not-a-real-token').expect(404);                     // malformed token: same 404 as unknown
    await s.get(`/api/vote/${'A'.repeat(32)}`).expect(404);
  });
});

describe('authorisation', () => {
  it('Admin B cannot read or modify Admin A campaign (404) and attempts are audit-logged', async () => {
    const a = await login(app, ADMIN_A);
    const b = await login(app, ADMIN_B);
    const c = await makeCampaign(a, 2);
    const base = `/api/campaigns/${c.id}`;
    await b.get(base).expect(404);
    await b.patch(base).send({ title: 'hijack' }).expect(404);
    await b.post(`${base}/candidates`).field('name', 'x').expect(404);
    await b.put(`${base}/eligible`).send({ mode: 'all' }).expect(404);
    await b.post(`${base}/start`).expect(404);
    await b.post(`${base}/close`).expect(404);
    await b.get(`${base}/results`).expect(404);
    await b.get(`${base}/results.csv`).expect(404);
    await b.get(`${base}/qr.png`).expect(404);
    await b.post(`${base}/publish`).expect(404);
    const nonexistent = await b.get('/api/campaigns/00000000-0000-4000-8000-000000000000').expect(404);
    expect(nonexistent.body).toEqual({ error: 'Not found', code: undefined });
    const row = await ownerDb().query('SELECT title, status FROM campaigns WHERE id = $1', [c.id]);
    expect(row.rows[0]).toMatchObject({ title: 'Test vote', status: 'draft' });
    const logs = await ownerDb().query("SELECT * FROM audit_log WHERE action = 'authz.denied' AND actor_oid = $1 AND campaign_id = $2", [ADMIN_B.oid, c.id]);
    expect(logs.rowCount).toBe(10);   // one per attempt above on this campaign
    const ghost = await ownerDb().query("SELECT 1 FROM audit_log WHERE action = 'authz.denied' AND actor_oid = $1 AND campaign_id = '00000000-0000-4000-8000-000000000000'", [ADMIN_B.oid]);
    expect(ghost.rowCount).toBe(1);   // probing a non-existent id is logged too
    expect((await b.get('/api/campaigns/mine')).body.campaigns).toEqual([]);
  });

  it('non-admin cannot use admin routes (403, audit-logged); anonymous gets 401', async () => {
    const s = await login(app, S1);
    await s.get('/api/campaigns/mine').expect(403);
    await s.post('/api/campaigns').send({ title: 'x' }).expect(403);
    const logs = await ownerDb().query("SELECT 1 FROM audit_log WHERE action = 'authz.denied' AND actor_oid = $1", [S1.oid]);
    expect(logs.rowCount).toBe(2);
    await request(app).get('/api/campaigns/mine').expect(401);
    await request(app).get('/api/vote/' + 'A'.repeat(32)).expect(401);
  });

  it('non-admin cannot forge the admin role (a forged or edited session cookie is ignored; roles are not in the cookie at all)', async () => {
    const agent = request.agent(app);
    const t = (await agent.get('/api/csrf')).body.token;
    const r = await agent.post('/api/dev/login').set('x-csrf-token', t).send(S1).expect(200);
    const cookie = (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('namra_session='))!;
    const value = decodeURIComponent(cookie.split(';')[0].split('=')[1]);
    expect(value).not.toContain('CampaignAdmin');
    expect(() => JSON.parse(Buffer.from(value.split('.')[0], 'base64url').toString())).toThrow();   // an opaque random id, not a JSON payload
    const forged = Buffer.from(JSON.stringify({ oid: ADMIN_A.oid, email: ADMIN_A.email, roles: ['CampaignAdmin'], exp: Date.now() + 1e9 })).toString('base64url');
    await request(app).get('/api/campaigns/mine').set('Cookie', `namra_session=${forged}.AAAA`).expect(401);
    await request(app).get('/api/campaigns/mine').set('Cookie', `namra_session=${value.slice(0, -2)}xx`).expect(401);   // edited mac
  });

  it('every admin mutation writes an audit entry', async () => {
    const a = await login(app, ADMIN_A);
    const c = await makeCampaign(a, 2);
    await a.patch(`/api/campaigns/${c.id}`).send({ title: 'Renamed' }).expect(200);
    await a.put(`/api/campaigns/${c.id}/eligible`).send({ mode: 'all' }).expect(200);
    await a.post(`/api/campaigns/${c.id}/start`).expect(200);
    await a.post(`/api/campaigns/${c.id}/close`).expect(200);
    await a.post(`/api/campaigns/${c.id}/publish`).expect(200);
    const acts = (await ownerDb().query('SELECT action FROM audit_log WHERE campaign_id = $1', [c.id])).rows.map((r) => r.action);
    for (const x of ['campaign.create', 'candidate.add', 'campaign.update', 'eligibility.set', 'campaign.start', 'campaign.close', 'results.publish'])
      expect(acts).toContain(x);
  });
});

describe('my votes list', () => {
  it('lists only open campaigns the caller is eligible for, with their voted state', async () => {
    const a = await login(app, ADMIN_A);
    const everyone = await makeCampaign(a, 2, 'For everyone');
    const listed = await makeCampaign(a, 2, 'Listed only');
    const draft = await makeCampaign(a, 2, 'Still a draft');
    await a.put(`/api/campaigns/${listed.id}/eligible`).send({ mode: 'list', emails: [S1.email] }).expect(200);
    await a.post(`/api/campaigns/${everyone.id}/start`).expect(200);
    await a.post(`/api/campaigns/${listed.id}/start`).expect(200);

    const s1 = await login(app, S1);
    const s2 = await login(app, S2);
    await s1.post(`/api/vote/${everyone.token}`).send({ candidateId: everyone.candidates[0] }).expect(201);

    const l1 = (await s1.get('/api/vote').expect(200)).body.campaigns;
    expect(l1.map((c: { title: string }) => c.title).sort()).toEqual(['For everyone', 'Listed only']);
    expect(l1.find((c: { title: string }) => c.title === 'For everyone').voterState).toBe('already_voted');
    expect(l1.find((c: { title: string }) => c.title === 'Listed only').voterState).toBe('can_vote');

    const l2 = (await s2.get('/api/vote').expect(200)).body.campaigns;
    expect(l2.map((c: { title: string }) => c.title)).toEqual(['For everyone']);
    expect(JSON.stringify(l1)).not.toContain(draft.token);
    expect(JSON.stringify(l1)).not.toContain('candidate');          // no ballot or candidate data in the list
    await request(app).get('/api/vote').expect(401);
  });
});

describe('dashboard summary', () => {
  it('is creator-scoped, admin-only, and reports counts, winner and turnout', async () => {
    const a = await login(app, ADMIN_A);
    const b = await login(app, ADMIN_B);
    const draft = await makeCampaign(a, 1, 'Draft one');
    const open = await makeCampaign(a, 2, 'Open one');
    await a.post(`/api/campaigns/${open.id}/start`).expect(200);
    const done = await makeCampaign(a, 2, 'Done one');
    await a.put(`/api/campaigns/${done.id}/eligible`).send({ mode: 'list', emails: [S1.email, S2.email, S3.email] }).expect(200);
    await a.post(`/api/campaigns/${done.id}/start`).expect(200);
    for (const u of [S1, S2]) await (await login(app, u)).post(`/api/vote/${done.token}`).send({ candidateId: done.candidates[1] }).expect(201);
    await (await login(app, S3)).post(`/api/vote/${open.token}`).send({ candidateId: open.candidates[0] }).expect(201);
    await a.post(`/api/campaigns/${done.id}/close`).expect(200);

    const s = (await a.get('/api/campaigns/summary').expect(200)).body;
    expect(s.counts).toEqual({ active: 1, drafts: 1, archived: 0, votes_open: 1 });
    expect(s.featured.id).toBe(open.id);
    expect(s.open).toHaveLength(1);
    expect(s.closed).toHaveLength(1);
    expect(s.closed[0]).toMatchObject({ id: done.id, turnout: 2, eligible_count: 3, winner: { name: 'Candidate 2', votes: 2, tie: false } });
    expect(s.closed[0].closed_at).toBeTruthy();
    expect(JSON.stringify(s)).not.toContain(draft.token);

    const other = (await b.get('/api/campaigns/summary').expect(200)).body;
    expect(other.counts).toEqual({ active: 0, drafts: 0, archived: 0, votes_open: 0 });
    expect(other.closed).toEqual([]);
    await (await login(app, S1)).get('/api/campaigns/summary').expect(403);
    await request(app).get('/api/campaigns/summary').expect(401);
  });
});

describe('locking after start', () => {
  it('rejects every edit once the campaign is open', async () => {
    const a = await login(app, ADMIN_A);
    const c = await makeCampaign(a, 2);
    await a.post(`/api/campaigns/${c.id}/start`).expect(200);
    const base = `/api/campaigns/${c.id}`;
    await a.patch(base).send({ title: 'nope' }).expect(409);
    await a.post(`${base}/candidates`).field('name', 'late').expect(409);
    await a.patch(`${base}/candidates/${c.candidates[0]}`).field('name', 'renamed').expect(409);
    await a.del(`${base}/candidates/${c.candidates[0]}`).expect(409);
    await a.put(`${base}/eligible`).send({ mode: 'all' }).expect(409);
    await a.post(`${base}/start`).expect(409);
    const names = await ownerDb().query('SELECT name FROM candidates WHERE campaign_id = $1 ORDER BY sort_order', [c.id]);
    expect(names.rows.map((r) => r.name)).toEqual(['Candidate 1', 'Candidate 2']);
  });

  it('the database trigger blocks candidate changes on a locked campaign even for the app role', async () => {
    const a = await login(app, ADMIN_A);
    const c = await makeCampaign(a, 2);
    await a.post(`/api/campaigns/${c.id}/start`).expect(200);
    const db = new pg.Client({ connectionString: TEST_APP_URL });
    await db.connect();
    try {
      await expect(db.query("UPDATE candidates SET name = 'x' WHERE campaign_id = $1", [c.id])).rejects.toThrow(/locked/);
    } finally { await db.end(); }
  });
});

describe('ballot secrecy (schema)', () => {
  it('SEC-02: there is no row per vote: no ballots table, and a tally row holds only counts', async () => {
    expect((await ownerDb().query("SELECT to_regclass('public.ballots') AS t")).rows[0].t).toBeNull();
    const cols = await ownerDb().query("SELECT column_name FROM information_schema.columns WHERE table_name = 'tallies' ORDER BY column_name");
    expect(cols.rows.map((r) => r.column_name)).toEqual(['campaign_id', 'candidate_id', 'votes']);
    const receipts = await ownerDb().query("SELECT column_name FROM information_schema.columns WHERE table_name = 'vote_receipts' ORDER BY column_name");
    expect(receipts.rows.map((r) => r.column_name)).toEqual(['campaign_id', 'member_key', 'voter_oid']);   // no candidate, no timestamp
  });

  it('SEC-02 regression: no tally row shares its hidden xmin with any receipt (the old ballots/receipts join is dead)', async () => {
    const a = await login(app, ADMIN_A);
    const c = await makeCampaign(a, 3);
    await a.post(`/api/campaigns/${c.id}/start`).expect(200);
    for (const [i, u] of [S1, S2, S3, S4].entries()) await (await login(app, u)).post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[i % 3] }).expect(201);
    const t = await ownerDb().query('SELECT DISTINCT xmin::text AS x FROM tallies WHERE campaign_id = $1', [c.id]);
    expect(t.rowCount, 'every tally row carries the same re-stamped xmin').toBe(1);
    const r = await ownerDb().query('SELECT xmin::text AS x FROM vote_receipts WHERE campaign_id = $1', [c.id]);
    expect(r.rowCount).toBe(4);
    expect(r.rows.map((x) => x.x)).not.toContain(t.rows[0].x);
    const joined = await ownerDb().query('SELECT 1 FROM vote_receipts r JOIN tallies y ON y.campaign_id = r.campaign_id AND y.xmin::text = r.xmin::text WHERE r.campaign_id = $1', [c.id]);
    expect(joined.rowCount).toBe(0);
  });

  it('audit log never contains candidate ids or vote data after voting', async () => {
    const a = await login(app, ADMIN_A);
    const c = await makeCampaign(a, 2);
    await a.post(`/api/campaigns/${c.id}/start`).expect(200);
    const s = await login(app, S1);
    await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
    await a.post(`/api/campaigns/${c.id}/close`).expect(200);
    const rows = await ownerDb().query("SELECT * FROM audit_log WHERE actor_oid = $1 OR action LIKE 'vote%'", [S1.oid]);
    expect(rows.rowCount).toBe(0);
  });

  it('app DB role cannot UPDATE/DELETE audit_log or receipts, cannot delete tallies, and can only add one vote at a time', async () => {
    const a = await login(app, ADMIN_A);
    const c = await makeCampaign(a, 2);
    await a.post(`/api/campaigns/${c.id}/start`).expect(200);
    const s = await login(app, S1);
    await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
    const db = new pg.Client({ connectionString: TEST_APP_URL });
    await db.connect();
    try {
      for (const sql of [
        'DELETE FROM tallies', 'TRUNCATE tallies',
        'UPDATE audit_log SET action = action', 'DELETE FROM audit_log',
        'UPDATE vote_receipts SET voter_oid = voter_oid', 'DELETE FROM vote_receipts',
      ]) await expect(db.query(sql), sql).rejects.toThrow(/permission denied/);
      await expect(db.query('UPDATE tallies SET votes = votes + 2')).rejects.toThrow(/one vote at a time/);
      await expect(db.query('UPDATE tallies SET votes = 0')).rejects.toThrow(/one vote at a time/);
      await db.query('UPDATE tallies SET votes = votes');                                        // re-stamp (unchanged) is allowed
      expect((await db.query('SELECT coalesce(sum(votes), 0)::int AS n FROM tallies')).rows[0].n).toBe(1);
    } finally { await db.end(); }
  });
});

describe('uploads', () => {
  it('rejects a renamed .exe', async () => {
    const a = await login(app, ADMIN_A);
    const c = await makeCampaign(a, 0);
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(2000, 1)]);
    const r = await a.post(`/api/campaigns/${c.id}/candidates`).field('name', 'x').attach('photo', exe, { filename: 'photo.jpg', contentType: 'image/jpeg' }).expect(400);
    expect(r.body.code).toBe('bad_image');
    expect((await ownerDb().query('SELECT 1 FROM candidates WHERE campaign_id = $1', [c.id])).rowCount).toBe(0);
  });

  it('rejects files over 2 MB', async () => {
    const a = await login(app, ADMIN_A);
    const c = await makeCampaign(a, 0);
    const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2 * 1024 * 1024 + 10, 7)]);
    await a.post(`/api/campaigns/${c.id}/candidates`).field('name', 'x').attach('photo', big, { filename: 'big.jpg', contentType: 'image/jpeg' }).expect(413);
  });

  it('accepts a PNG, re-encodes to JPEG max 800px and serves it via the authenticated route only', async () => {
    const a = await login(app, ADMIN_A);
    const c = await makeCampaign(a, 0);
    const r = await a.post(`/api/campaigns/${c.id}/candidates`).field('name', 'Pic').attach('photo', await png(2000, 1500), { filename: 'p.png', contentType: 'image/png' }).expect(201);
    expect(r.body.photo_url).toBe(`/api/photos/${r.body.id}`);
    expect(r.body.photo_path).toBeUndefined();
    const img = await a.get(r.body.photo_url).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []; res.on('data', (d: Buffer) => chunks.push(d)); res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    const meta = await sharp(img.body as Buffer).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(800);
    await request(app).get(r.body.photo_url).expect(401);
    const other = await login(app, ADMIN_B);
    await other.get(r.body.photo_url).expect(404);           // draft photos: creator only
    const stored = await ownerDb().query('SELECT photo_path FROM candidates WHERE id = $1', [r.body.id]);
    expect(stored.rows[0].photo_path).toMatch(/^[0-9a-f]{32}\.jpg$/);
  });
});

describe('platform security', () => {
  it('sets security headers', async () => {
    const r = await request(app).get('/api/csrf').expect(200);
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('session cookie is HttpOnly + SameSite=Strict', async () => {
    const agent = request.agent(app);
    const t = (await agent.get('/api/csrf')).body.token;
    const r = await agent.post('/api/dev/login').set('x-csrf-token', t).send(S1).expect(200);
    const c = (r.headers['set-cookie'] as unknown as string[]).find((x) => x.startsWith('namra_session='))!;
    expect(c).toMatch(/HttpOnly/i);
    expect(c).toMatch(/SameSite=Strict/i);
  });

  it('rejects state-changing requests without a valid CSRF token', async () => {
    const agent = request.agent(app);
    await agent.post('/api/dev/login').send(S1).expect(403);
    const t = (await agent.get('/api/csrf')).body.token;
    await agent.post('/api/dev/login').set('x-csrf-token', t + 'x').send(S1).expect(403);
    await agent.post('/api/dev/login').set('x-csrf-token', 'a.b').send(S1).expect(403);
  });

  it('does not leak stack traces', async () => {
    const s = await login(app, ADMIN_A);
    const r = await s.post('/api/campaigns').set('Content-Type', 'application/json').send('{bad json').expect(400);
    expect(JSON.stringify(r.body)).not.toMatch(/at .*\.(ts|js)/);
    const r2 = await s.get('/api/campaigns/not-a-uuid').expect(400);
    expect(r2.body.error).toBe('Invalid request');
  });
});
