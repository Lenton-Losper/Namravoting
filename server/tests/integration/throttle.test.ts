import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_A, ADMIN_B, S1, S2, TEST_OWNER_URL, closeOwner, login, makeCampaign, ownerDb, resetDb } from '../helpers.js';

// Small limits for this file only; config is read lazily, so set them BEFORE the app is imported.
process.env.AUTH_RATE_LIMIT_PER_MIN = '3';
process.env.READ_RATE_LIMIT_PER_MIN = '5';
process.env.ADMIN_RATE_LIMIT_PER_MIN = '30';

let app: import('express').Express;
let closePool: () => Promise<void>;
beforeAll(async () => {
  app = (await import('../../src/app.js')).createApp();
  closePool = (await import('../../src/db.js')).closePool;
});
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

const statuses = async (n: number, f: (i: number) => request.Test) => { const out: number[] = []; for (let i = 0; i < n; i++) out.push((await f(i)).status); return out; };

describe('SEC-08: throttling where there is no signed-in user to key on', () => {
  it('/auth/* is limited per client address; another address has its own allowance', async () => {
    const hit = (ip: string) => request(app).get('/auth/login').set('cf-connecting-ip', ip);
    const a = await statuses(5, () => hit('203.0.113.7'));
    expect(a.slice(0, 3)).not.toContain(429);
    expect(a.slice(3)).toEqual([429, 429]);
    expect((await hit('203.0.113.8')).status).not.toBe(429);                      // a different client is not affected
    const r = await hit('203.0.113.7');
    expect(r.status).toBe(429);
    expect(r.text).toMatch(/Too many sign-in attempts/);
  });

  it('a made-up CF-Connecting-IP value cannot be used to dodge the limit (invalid values fall back to the socket address)', async () => {
    const out = await statuses(6, (i) => request(app).get('/auth/login').set('cf-connecting-ip', `not-an-ip-${i}`));
    expect(out.filter((s) => s === 429).length).toBeGreaterThanOrEqual(3);
  });

  it('/api/csrf is limited too', async () => {
    const out = await statuses(15, () => request(app).get('/api/csrf').set('cf-connecting-ip', '198.51.100.1'));   // limit is 4 x AUTH_RATE_LIMIT = 12
    expect(out.slice(0, 12).every((s) => s === 200)).toBe(true);
    expect(out.slice(12)).toEqual([429, 429, 429]);
  });
});

describe('SEC-08: signed-in callers', () => {
  it('a non-admin cannot hammer the admin gate: the limiter runs first and the audit log gets one row, not one per request', async () => {
    const s = await login(app, S1);
    const out = await statuses(40, () => s.get('/api/campaigns/mine'));
    expect(out.filter((x) => x === 403).length).toBe(30);
    expect(out.filter((x) => x === 429).length).toBe(10);
    const rows = await ownerDb().query("SELECT 1 FROM audit_log WHERE action = 'authz.denied' AND actor_oid = $1", [S1.oid]);
    expect(rows.rowCount).toBe(1);
  });

  it('control: an admin is not blocked by the audit de-duplication, only by the limit', async () => {
    const a = await login(app, ADMIN_A);
    const out = await statuses(33, () => a.get('/api/campaigns/mine'));
    expect(out.slice(0, 30).every((x) => x === 200)).toBe(true);
    expect(out.slice(30)).toEqual([429, 429, 429]);
  });

  it('GET vote routes are limited per user', async () => {
    const s = await login(app, S2);
    const out = await statuses(8, () => s.get('/api/vote'));
    expect(out.slice(0, 5).every((x) => x === 200)).toBe(true);
    expect(out.slice(5).every((x) => x === 429)).toBe(true);
    const other = await login(app, S1);
    await other.get('/api/vote').expect(200);                                    // another user has their own allowance
  });
});

describe('SEC-08: reading a ballot page does not take a write lock', () => {
  it('a campaign that is not due for closing is read without FOR UPDATE (a held row lock does not block the page)', async () => {
    const admin = await login(app, ADMIN_B);
    const c = await makeCampaign(admin, 2);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const voter = await login(app, S1);
    const holder = new pg.Client({ connectionString: TEST_OWNER_URL });
    await holder.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM campaigns WHERE id = $1 FOR UPDATE', [c.id]);   // someone holds the row lock
      const started = Date.now();
      await voter.get(`/api/vote/${c.token}`).expect(200);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally { await holder.query('ROLLBACK'); await holder.end(); }
  });
});
