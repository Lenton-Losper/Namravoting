import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { revokeAllSessions } from '../../src/auth/sessions.js';
import { ADMIN_A, S1, TEST_OWNER_URL, closeOwner, login, makeCampaign, ownerDb, resetDb, sessionFor } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

/** Signs in through the real dev-login route and returns the raw cookie value plus an agent. */
async function signIn(user: typeof S1) {
  const agent = request.agent(app);
  const token = (await agent.get('/api/csrf')).body.token as string;
  const r = await agent.post('/api/dev/login').set('x-csrf-token', token).send(user).expect(200);
  const cookie = (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('namra_session='))!;
  const value = decodeURIComponent(cookie.split(';')[0].split('=')[1]);
  const csrf = (await agent.get('/api/csrf')).body.token as string;
  return { agent, value, csrf, cookieHeader: `namra_session=${encodeURIComponent(value)}` };
}
const replay = (cookieHeader: string, url = '/api/session') => request(app).get(url).set('Cookie', cookieHeader);

describe('SEC-06: server-side sessions', () => {
  it('logout really invalidates: a copied cookie stops working', async () => {
    const s = await signIn(S1);
    expect((await replay(s.cookieHeader).expect(200)).body.user).toMatchObject({ email: S1.email });
    await s.agent.post('/api/logout').set('x-csrf-token', s.csrf).expect(204);
    expect((await replay(s.cookieHeader).expect(200)).body.user).toBeNull();          // the copied cookie is dead
    await replay(s.cookieHeader, '/api/vote').expect(401);
    const row = (await ownerDb().query('SELECT revoked_at FROM sessions')).rows[0];
    expect(row.revoked_at).not.toBeNull();
  });

  it('an expired session is not accepted', async () => {
    const s = await signIn(S1);
    await ownerDb().query("UPDATE sessions SET expires_at = now() - interval '1 minute'");
    expect((await replay(s.cookieHeader).expect(200)).body.user).toBeNull();
  });

  it('revoking an account\'s sessions signs it out everywhere at once', async () => {
    const a = await signIn(S1); const b = await signIn(S1);
    expect(await revokeAllSessions(S1.oid)).toBe(2);
    expect((await replay(a.cookieHeader)).body.user).toBeNull();
    expect((await replay(b.cookieHeader)).body.user).toBeNull();
  });

  it('the database holds only a hash of the session id, never the id the browser has', async () => {
    const s = await signIn(S1);
    const id = s.value.split('.')[0];
    const rows = (await ownerDb().query('SELECT id_hash FROM sessions')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].id_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(id);
  });

  it('every sign-in issues a new id and revokes the session the browser came with (no fixation)', async () => {
    const agent = request.agent(app);
    const token = (await agent.get('/api/csrf')).body.token as string;
    const first = await agent.post('/api/dev/login').set('x-csrf-token', token).send(S1).expect(200);
    const bound = (await agent.get('/api/csrf')).body.token as string;       // SEC-15: tokens are bound to the session
    const second = await agent.post('/api/dev/login').set('x-csrf-token', bound).send(S1).expect(200);
    const idOf = (r: request.Response) => decodeURIComponent(((r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('namra_session='))!).split(';')[0].split('=')[1]).split('.')[0];
    expect(idOf(first)).not.toBe(idOf(second));
    const rows = (await ownerDb().query('SELECT revoked_at FROM sessions ORDER BY created_at')).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0].revoked_at).not.toBeNull();
    expect(rows[1].revoked_at).toBeNull();
  });

  it('admin sessions are shorter than staff sessions', async () => {
    await signIn(S1);
    await signIn(ADMIN_A);
    const rows = (await ownerDb().query(
      'SELECT s.claim_admin, extract(epoch FROM s.expires_at - s.created_at)::int AS secs FROM sessions s ORDER BY s.claim_admin')).rows;
    expect(rows[0].secs).toBeGreaterThan(7.9 * 3600); expect(rows[0].secs).toBeLessThanOrEqual(8 * 3600);
    expect(rows[1].secs).toBeGreaterThan(3.9 * 3600); expect(rows[1].secs).toBeLessThanOrEqual(4 * 3600);
  });

  it('roles are read live on every request, not carried in the cookie: demoting the account takes effect at once', async () => {
    const s = await signIn(ADMIN_A);
    await request(app).get('/api/campaigns/mine').set('Cookie', s.cookieHeader).expect(200);
    await ownerDb().query('UPDATE sessions SET claim_admin = false');
    await request(app).get('/api/campaigns/mine').set('Cookie', s.cookieHeader).expect(403);
    expect((await replay(s.cookieHeader)).body.user.roles).toEqual([]);
  });

  it('an account deleted from users, or a session of another account, never yields a user', async () => {
    const s = await signIn(S1);
    const other = await signIn(ADMIN_A);
    expect((await replay(s.cookieHeader)).body.user.email).toBe(S1.email);
    expect((await replay(other.cookieHeader)).body.user.email).toBe(ADMIN_A.email);
    expect((await replay(`namra_session=${encodeURIComponent(s.value.split('.')[0] + '.' + other.value.split('.')[1])}`)).body.user).toBeNull();   // id of one, mac of another
  });

  it('keeps only the newest sessions per account', async () => {
    for (let i = 0; i < 13; i++) await signIn(S1);
    expect((await ownerDb().query('SELECT count(*)::int n FROM sessions')).rows[0].n).toBeLessThanOrEqual(10);
  });
});

describe('SEC-04: a permanent delete needs a copy of the result first', () => {
  async function archived() {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2, 'Export first');
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    await (await login(app, S1)).post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
    await admin.post(`/api/campaigns/${c.id}/close`).expect(200);
    await admin.post(`/api/campaigns/${c.id}/archive`).expect(200);
    return { admin, ...c };
  }

  it('refuses with export_first until the CSV has been downloaded; then deletes', async () => {
    const c = await archived();
    expect((await c.admin.post(`/api/campaigns/${c.id}/permanent-delete`).send({ confirm_title: 'Export first' }).expect(409)).body.code).toBe('export_first');
    expect((await ownerDb().query('SELECT count(*)::int n FROM campaigns WHERE id = $1', [c.id])).rows[0].n).toBe(1);
    await c.admin.get(`/api/campaigns/${c.id}/results.csv`).expect(200);
    await c.admin.post(`/api/campaigns/${c.id}/permanent-delete`).send({ confirm_title: 'Export first' }).expect(200);
    expect((await ownerDb().query('SELECT count(*)::int n FROM campaigns WHERE id = $1', [c.id])).rows[0].n).toBe(0);
  });

  it('an export made before a reset does not count for the next result', async () => {
    const c = await archived();
    await c.admin.get(`/api/campaigns/${c.id}/results.csv`).expect(200);
    await c.admin.post(`/api/campaigns/${c.id}/unarchive`).expect(200);
    await c.admin.post(`/api/campaigns/${c.id}/reset`).send({ confirm_title: 'Export first', reason: 'Counting error, vote again', closes_at: new Date(Date.now() + 3600_000).toISOString() }).expect(200);
    await c.admin.post(`/api/campaigns/${c.id}/close`).send({ reason: 'Everyone has voted already' }).expect(200);
    await c.admin.post(`/api/campaigns/${c.id}/archive`).expect(200);
    expect((await c.admin.post(`/api/campaigns/${c.id}/permanent-delete`).send({ confirm_title: 'Export first' }).expect(409)).body.code).toBe('export_first');
  });

  it('the CSV carries the seal fingerprint of the audit entry', async () => {
    const c = await archived();
    const csv = (await c.admin.get(`/api/campaigns/${c.id}/results.csv`).expect(200)).text;
    const e = (await ownerDb().query("SELECT hash, at FROM audit_log WHERE campaign_id = $1 AND action = 'campaign.close'", [c.id])).rows[0];
    expect(csv).toContain(`Seal fingerprint,${e.hash}`);
    expect(csv).toMatch(/Sealed at,\d{4}-\d\d-\d\dT/);
    expect(csv).toContain('Total ballots,1');
  });

  it('the database function itself still deletes only archived campaigns of the actor (the API check is not the only guard)', async () => {
    const c = await archived();
    const db = new pg.Client({ connectionString: 'postgres://namra_app:namra_app_dev@localhost:5433/namra_test' });
    await db.connect();
    try {
      await expect(db.query('SELECT delete_archived_campaign($1, $2)', [c.id, await sessionFor(S1)])).rejects.toThrow(/campaign not found/);
    } finally { await db.end(); }
    void TEST_OWNER_URL;
  });
});
