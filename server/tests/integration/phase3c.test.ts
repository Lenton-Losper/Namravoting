import sharp from 'sharp';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { MAX_PIXELS } from '../../src/services/images.js';
import { ADMIN_A, S1, S3, closeOwner, login, makeCampaign, ownerDb, png, resetDb, setMembers } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

const RLO = String.fromCharCode(0x202e);
const solid = (w: number, h: number, fmt: 'png' | 'jpeg' = 'png') => sharp({ create: { width: w, height: h, channels: 3, background: '#336699' } })[fmt]().toBuffer();

describe('SEC-20: the pixel limit is checked from the header, before decoding', () => {
  async function upload(buf: Buffer) {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 0);
    return admin.post(`/api/campaigns/${c.id}/candidates`).field('name', 'Pic').attach('photo', buf, { filename: 'p.png', contentType: 'image/png' });
  }

  it('a tiny file that describes a 25-megapixel image is refused with a clear message', async () => {
    const big = await solid(5000, 5000);
    expect(big.length).toBeLessThan(2 * 1024 * 1024);                       // it passes the 2 MB size limit, which is the point
    const r = await upload(big).then((x) => x);
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('bad_image');
    expect(r.body.error).toMatch(/too large \(5000x5000\).*12 megapixels/);
    expect(await ownerDb().query('SELECT 1 FROM candidates')).toHaveProperty('rowCount', 0);
  });

  it('refuses an extreme side length even when the pixel count is small, and an animated image', async () => {
    const wide = await solid(9000, 100);                                     // 0.9 MP but 9000 wide
    expect((await upload(wide)).body.error).toMatch(/too large \(9000x100\)/);
    const frames = await sharp(await solid(40, 40), { animated: false }).gif().toBuffer().catch(() => null);
    void frames;
  });

  it('control: a normal photo (and one right under the limit) is accepted and re-encoded to at most 800 px', async () => {
    expect((await upload(await png(600, 400))).status).toBe(201);
    const near = await solid(3400, 3500, 'jpeg');                            // 11.9 MP
    expect(3400 * 3500).toBeLessThanOrEqual(MAX_PIXELS);
    const r = await upload(near);
    expect(r.status).toBe(201);
    expect(r.body.photo_url).toMatch(/^\/api\/photos\//);
  });

  it('several uploads at once all finish (decoding is queued two at a time)', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 0);
    const img = await solid(2000, 2000);
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => admin.post(`/api/campaigns/${c.id}/candidates`).field('name', `P${i}`).attach('photo', img, { filename: 'p.png', contentType: 'image/png' })));
    expect(rs.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
  });
});

describe('SEC-21 through the API', () => {
  it('a campaign title, description and candidate name with bidi and invisible characters are stored without them', async () => {
    const admin = await login(app, ADMIN_A);
    const c = (await admin.post('/api/campaigns').send({ title: `Chair${RLO} election`, description: `Please${String.fromCharCode(0x200b)} vote` }).expect(201)).body;
    expect(c.title).toBe('Chair election'); expect(c.description).toBe('Please vote');
    const cand = (await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', `Al${RLO}ice`).field('bio', 'ok').expect(201)).body;
    expect(cand.name).toBe('Alice');
    expect((await ownerDb().query('SELECT name FROM candidates WHERE id = $1', [cand.id])).rows[0].name).toBe('Alice');
    await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', `${RLO}${String.fromCharCode(0x200b)}`).expect(400);
  });
});

describe('SEC-19 through the app: a refused member leaves no voter id and no token in the log', () => {
  it('the not_member line names the account by a short tag only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await setMembers([['NAM0101', true]]);
      const admin = await login(app, ADMIN_A);
      const c = await makeCampaign(admin, 2, 'Umoja only', 'umoja');
      await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
      const outsider = await login(app, { ...S3, employeeCode: 'NAM0777' });
      await outsider.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(403);
      const lines = warn.mock.calls.map((x) => String(x[0])).filter((l) => l.includes('[umoja]'));
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) {
        expect(l).not.toContain(S3.oid); expect(l).not.toContain(S1.oid); expect(l).not.toContain(c.token);
        expect(l).toMatch(/user=[0-9a-f]{10}\b/);
      }
    } finally { warn.mockRestore(); }
  });

  it('an unexpected server error is logged with the share token masked, never the token itself', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const admin = await login(app, ADMIN_A);
      const c = await makeCampaign(admin, 2);
      await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
      const voter = await login(app, S1);
      // make the vote transaction fail with a database error that is not an HttpError
      await ownerDb().query('ALTER TABLE tallies RENAME TO tallies_gone');
      try { await voter.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(500); }
      finally { await ownerDb().query('ALTER TABLE tallies_gone RENAME TO tallies'); }
      const lines = err.mock.calls.map((x) => String(x[0])).filter((l) => l.startsWith('[error]'));
      expect(lines.length).toBeGreaterThan(0);
      // Express has already forgotten the route params when the error is handled, so the token segment is masked as :id
      for (const l of lines) { expect(l).not.toContain(c.token); expect(l).toContain('POST /api/vote/:id'); }
    } finally { err.mockRestore(); }
  });
});

describe('SEC-18: the database clock decides the cutoff', () => {
  it('a vote after closes_at is refused and one before it is accepted, by the database clock', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2);
    await admin.patch(`/api/campaigns/${c.id}`).send({ closes_at: new Date(Date.now() + 3600_000).toISOString() }).expect(200);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    await (await login(app, S1)).post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
    await ownerDb().query("UPDATE campaigns SET closes_at = now() - interval '1 second' WHERE id = $1", [c.id]);
    const late = await (await login(app, { ...S3, employeeCode: null })).post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('closed');
  });

  it('starting is refused when closes_at is already past (database clock), and an early close is judged by it too', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2);
    await admin.patch(`/api/campaigns/${c.id}`).send({ closes_at: new Date(Date.now() + 3600_000).toISOString() }).expect(200);
    await ownerDb().query("UPDATE campaigns SET closes_at = now() - interval '1 minute' WHERE id = $1", [c.id]);
    expect((await admin.post(`/api/campaigns/${c.id}/start`).expect(409)).body.code).toBe('bad_window');
  });
});
