import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';

// Config is read once per module graph, so set the limits before importing the app.
process.env.VOTE_RATE_LIMIT_PER_MIN = '3';
process.env.ADMIN_RATE_LIMIT_PER_MIN = '5';

let app: Express;
let helpers: typeof import('../helpers.js');

beforeAll(async () => {
  helpers = await import('../helpers.js');
  const { createApp } = await import('../../src/app.js');
  app = createApp();
  await helpers.resetDb();
});
afterAll(async () => {
  const { closePool } = await import('../../src/db.js');
  await closePool(); await helpers.closeOwner();
});

describe('rate limits', () => {
  it('limits vote POSTs per user and admin routes per user', async () => {
    const admin = await helpers.login(app, helpers.ADMIN_A);
    const c = await helpers.makeCampaign(admin, 2);                // 3 admin calls (create + 2 candidates)
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);  // 4th
    const s = await helpers.login(app, helpers.S1);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] })).status);
    expect(codes).toEqual([201, 409, 409, 429, 429]);
    await admin.get('/api/campaigns/mine').expect(200);            // 5th
    await admin.get('/api/campaigns/mine').expect(429);            // 6th
    // another user is unaffected
    const s2 = await helpers.login(app, helpers.S2);
    await s2.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
  });
});
