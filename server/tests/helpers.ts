import pg from 'pg';
import request from 'supertest';
import sharp from 'sharp';
import type { Express } from 'express';
import { DEV_USERS } from '../src/auth/devUsers.js';
import type { AuthUser } from '../src/auth/types.js';

export const TEST_OWNER_URL = 'postgres://namra_owner:namra_owner_dev@localhost:5433/namra_test';
export const TEST_APP_URL = 'postgres://namra_app:namra_app_dev@localhost:5433/namra_test';
export const [ADMIN_A, ADMIN_B, S1, S2, S3, S4, S5] = DEV_USERS;

let owner: pg.Pool | undefined;
export const ownerDb = () => (owner ??= new pg.Pool({ connectionString: TEST_OWNER_URL, max: 3 }));
export async function closeOwner() { await owner?.end(); owner = undefined; }

export async function resetDb() {
  await ownerDb().query('TRUNCATE ballots, vote_receipts, eligible_voters, candidates, audit_log, campaigns, users CASCADE');
}

export interface Session {
  get(url: string): request.Test;
  post(url: string): request.Test;
  put(url: string): request.Test;
  patch(url: string): request.Test;
  del(url: string): request.Test;
}

/** Every JSON/text response body seen through `login()` sessions (used by the secrecy "walk" test). */
export const responseLog: { url: string; body: string }[] = [];
const record = (r: request.Response) => {
  const type = String(r.headers['content-type'] ?? '');
  if (/json|text/.test(type)) responseLog.push({ url: r.request?.url ?? '', body: typeof r.text === 'string' ? r.text : JSON.stringify(r.body ?? {}) });
};

/** Logs in through the real dev-login route and returns a CSRF-aware client. */
export async function login(app: Express, user: AuthUser): Promise<Session> {
  const agent = request.agent(app);
  const token = (await agent.get('/api/csrf')).body.token as string;
  await agent.post('/api/dev/login').set('x-csrf-token', token).send(user).on('response', record).expect(200);
  return {
    get: (u) => agent.get(u).on('response', record),
    post: (u) => agent.post(u).set('x-csrf-token', token).on('response', record),
    put: (u) => agent.put(u).set('x-csrf-token', token).on('response', record),
    patch: (u) => agent.patch(u).set('x-csrf-token', token).on('response', record),
    del: (u) => agent.delete(u).set('x-csrf-token', token).on('response', record),
  };
}

/** A cookie-less session for the anonymous case (CSRF token still supplied so we test auth, not CSRF). */
export async function anonymous(app: Express): Promise<Session> {
  const agent = request.agent(app);
  const token = (await agent.get('/api/csrf')).body.token as string;
  return {
    get: (u) => agent.get(u),
    post: (u) => agent.post(u).set('x-csrf-token', token),
    put: (u) => agent.put(u).set('x-csrf-token', token),
    patch: (u) => agent.patch(u).set('x-csrf-token', token),
    del: (u) => agent.delete(u).set('x-csrf-token', token),
  };
}

export const png = (w = 100, h = 80) =>
  sharp({ create: { width: w, height: h, channels: 3, background: '#3366cc' } }).png().toBuffer();

/** Creates a campaign with N candidates via the API and returns ids. */
export async function makeCampaign(admin: Session, n = 2, title = 'Test vote') {
  const c = (await admin.post('/api/campaigns').send({ title }).expect(201)).body;
  const candidates: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', `Candidate ${i + 1}`).field('bio', 'bio').expect(201);
    candidates.push(r.body.id);
  }
  return { id: c.id as string, token: c.share_token as string, candidates };
}

export const count = async (table: 'ballots' | 'vote_receipts', campaignId: string) =>
  (await ownerDb().query(`SELECT count(*)::int AS n FROM ${table} WHERE campaign_id = $1`, [campaignId])).rows[0].n as number;
