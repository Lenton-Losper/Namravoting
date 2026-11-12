import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { ADMIN_A, S1, closeOwner, ownerDb, resetDb } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

async function signIn(user: typeof S1) {
  const agent = request.agent(app);
  const token = (await agent.get('/api/csrf')).body.token as string;
  const r = await agent.post('/api/dev/login').set('x-csrf-token', token).send(user).expect(200);
  const cookie = (r.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('namra_session='))!;
  return `namra_session=${cookie.split(';')[0].split('=')[1]}`;
}
const me = (cookie: string) => request(app).get('/api/session').set('Cookie', cookie);
const secsLeft = async () => Number((await ownerDb().query('SELECT extract(epoch FROM expires_at - now()) AS s FROM sessions')).rows[0].s);

describe('sliding sessions: activity extends, idle times out, 12h is the ceiling', () => {
  it('a request pushes the idle deadline back to the full idle time (staff 8h, admins 4h)', async () => {
    const staff = await signIn(S1); const admin = await signIn(ADMIN_A);
    await ownerDb().query("UPDATE sessions SET expires_at = now() + interval '10 minutes'");
    expect((await me(staff)).body.user).not.toBeNull(); expect((await me(admin)).body.user).not.toBeNull();
    const rows = (await ownerDb().query('SELECT claim_admin, extract(epoch FROM expires_at - now()) AS s FROM sessions ORDER BY claim_admin')).rows;
    expect(Number(rows[0].s)).toBeGreaterThan(7.9 * 3600); expect(Number(rows[0].s)).toBeLessThanOrEqual(8 * 3600);
    expect(Number(rows[1].s)).toBeGreaterThan(3.9 * 3600); expect(Number(rows[1].s)).toBeLessThanOrEqual(4 * 3600);
  });

  it('an idle session expires: no request inside the idle time means signed out', async () => {
    const c = await signIn(S1);
    await ownerDb().query("UPDATE sessions SET expires_at = now() - interval '1 second'");
    expect((await me(c)).body.user).toBeNull();
    await request(app).get('/api/vote').set('Cookie', c).expect(401);
    expect(await secsLeft()).toBeLessThan(0);                       // and it is not revived by being asked about
  });

  it('activity keeps a session alive past what its first deadline was', async () => {
    const c = await signIn(S1);
    await ownerDb().query("UPDATE sessions SET created_at = now() - interval '7 hours', expires_at = now() + interval '30 seconds'");
    expect((await me(c)).body.user).not.toBeNull();                 // 7h old, but active
    expect(await secsLeft()).toBeGreaterThan(3600);
  });

  it('the absolute maximum is 12h after sign-in: the extension never goes past it, and after it the session is dead', async () => {
    const c = await signIn(S1);
    await ownerDb().query("UPDATE sessions SET created_at = now() - interval '11 hours 30 minutes', expires_at = now() + interval '1 minute'");
    expect((await me(c)).body.user).not.toBeNull();
    const left = await secsLeft();
    expect(left).toBeGreaterThan(25 * 60); expect(left).toBeLessThanOrEqual(30 * 60);   // capped at created_at + 12h, not now + 8h
    await ownerDb().query("UPDATE sessions SET created_at = now() - interval '12 hours 1 minute', expires_at = now() + interval '5 hours'");
    expect((await me(c)).body.user).toBeNull();                     // idle time left, but the ceiling has passed
    await request(app).get('/api/vote').set('Cookie', c).expect(401);
  });

  it('a revoked session is not revived by activity', async () => {
    const c = await signIn(S1);
    await ownerDb().query("UPDATE sessions SET revoked_at = now()");
    expect((await me(c)).body.user).toBeNull();
  });

  it('the expired-session answer is a plain 401 the client can act on', async () => {
    const r = await request(app).get('/api/vote').expect(401);
    expect(r.body.error).toBe('Not signed in');
  });
});
