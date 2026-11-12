import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import QRCode from 'qrcode';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { testHooks } from '../../src/services/voting.js';
import { ADMIN_A, S1, S2, S3, anonymous, closeOwner, count, login, makeCampaign, ownerDb, resetDb, responseLog } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

const openCampaign = async (title = 'Flow vote') => {
  const admin = await login(app, ADMIN_A);
  const c = await makeCampaign(admin, 2, title);
  await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
  return { admin, ...c };
};

describe('unknown / invalid tokens', () => {
  it('malformed and unknown tokens give the identical bare 404 on every voter route', async () => {
    const s = await login(app, S1);
    const bodies: unknown[] = [];
    for (const token of ['not-a-real-token', 'short', 'A'.repeat(32), 'B'.repeat(43), 'a b', '..%2F..']) {
      for (const [method, suffix] of [['get', ''], ['post', ''], ['get', '/results']] as const) {
        const r = method === 'get'
          ? await s.get(`/api/vote/${token}${suffix}`)
          : await s.post(`/api/vote/${token}`).send({ candidateId: '00000000-0000-4000-8000-000000000000' });
        expect(r.status, `${method} ${token}${suffix}`).toBe(404);
        bodies.push(r.body);
      }
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toEqual({ error: 'Not found' });
  });
});

describe('identity comes only from the server session', () => {
  it('a forged voter id / email / role in the body, query or headers is never honoured', async () => {
    const c = await openCampaign();
    const s1 = await login(app, S1);

    // Forged identity fields in the BODY are rejected outright (strict schema): nothing is recorded for anyone.
    for (const forged of [{ voter_oid: S2.oid }, { oid: S2.oid }, { email: S2.email }, { voterId: S2.oid }, { roles: ['CampaignAdmin'] }]) {
      await s1.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0], ...forged }).expect(400);
    }
    expect(await count('vote_receipts', c.id)).toBe(0);
    expect(await count('ballots', c.id)).toBe(0);

    // Forged QUERY params and HEADERS are ignored: the receipt belongs to the signed-in user only.
    await s1.post(`/api/vote/${c.token}?voter_oid=${S2.oid}&oid=${S2.oid}&email=${S2.email}`)
      .set('x-voter-oid', S2.oid).set('x-user-oid', S2.oid).set('x-user-email', S2.email).set('x-forwarded-user', S2.email)
      .send({ candidateId: c.candidates[0] }).expect(201);
    const receipts = await ownerDb().query('SELECT voter_oid FROM vote_receipts WHERE campaign_id = $1', [c.id]);
    expect(receipts.rows.map((r) => r.voter_oid)).toEqual([S1.oid]);
    expect((await (await login(app, S2)).get(`/api/vote/${c.token}`)).body.voterState).toBe('can_vote');   // S2 unaffected
  });

  it('forged email/role in query or headers does not grant eligibility, results or admin access', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2);
    await admin.put(`/api/campaigns/${c.id}/eligible`).send({ mode: 'list', emails: [S1.email] }).expect(200);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const s2 = await login(app, S2);
    await s2.get(`/api/vote/${c.token}?email=${S1.email}`).set('x-user-email', S1.email).expect(403);
    await s2.post(`/api/vote/${c.token}?email=${S1.email}`).set('x-user-email', S1.email).send({ candidateId: c.candidates[0] }).expect(403);
    await s2.get(`/api/vote/${c.token}/results?email=${S1.email}`).set('x-user-email', S1.email).expect(403);
    await s2.get('/api/campaigns/mine').set('x-roles', 'CampaignAdmin').set('x-user-roles', 'CampaignAdmin').expect(403);
    expect(await count('vote_receipts', c.id)).toBe(0);
  });
});

describe('idempotent submit', () => {
  it('a retry after a successful vote returns 409 already_voted and the state is already_voted; nothing is added', async () => {
    const c = await openCampaign();
    const s = await login(app, S1);
    await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
    for (let i = 0; i < 3; i++) {                                           // double tap / retry / second tab
      const r = await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[i % 2] }).expect(409);
      expect(r.body.code).toBe('already_voted');
    }
    expect((await s.get(`/api/vote/${c.token}`)).body.voterState).toBe('already_voted');
    // a second session ("second tab") for the same user hits the same primary key
    const tab2 = await login(app, S1);
    expect((await tab2.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[1] })).body.code).toBe('already_voted');
    expect(await count('vote_receipts', c.id)).toBe(1);
    expect(await count('ballots', c.id)).toBe(1);
  });
});

describe('closing is atomic', () => {
  it('votes racing a close: receipts = ballots, the audit count is final, and nothing is accepted after the close commits', async () => {
    const admin = await login(app, ADMIN_A);
    const voters = await Promise.all(Array.from({ length: 16 }, (_, i) => login(app, {
      oid: `e${String(i).padStart(7, '0')}-0000-4000-8000-000000000000`, email: `race${i}@namra.test`, displayName: `Racer ${i}`, roles: [], employeeCode: null,
    })));

    for (let round = 0; round < 12; round++) {
      const c = await makeCampaign(admin, 2, `Race ${round}`);
      await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
      const votes = voters.map((v, i) => v.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[i % 2] }).then((r) => r));
      // stagger the close across rounds (0..~33 ms) so it lands at different points of the vote burst
      const close = new Promise<void>((r) => setTimeout(r, round * 3)).then(() => admin.post(`/api/campaigns/${c.id}/close`)).then((r) => r);
      const [closeRes, ...voteRes] = await Promise.all([close, ...votes]);

      expect(closeRes.status).toBe(200);
      const accepted = voteRes.filter((r) => r.status === 201).length;
      const refused = voteRes.filter((r) => r.status === 409);
      expect(voteRes.filter((r) => ![201, 409].includes(r.status)).map((r) => r.status), 'unexpected statuses').toEqual([]);
      expect(refused.every((r) => r.body.code === 'closed')).toBe(true);

      const receipts = await count('vote_receipts', c.id);
      const ballots = await count('ballots', c.id);
      expect(receipts).toBe(ballots);
      expect(ballots).toBe(accepted);                       // every accepted vote is stored; every refused one is not
      // The integrity numbers audited at close are the FINAL numbers: no ballot was committed after the close counted.
      const audit = await ownerDb().query("SELECT action, details FROM audit_log WHERE campaign_id = $1 AND action LIKE 'campaign.close%'", [c.id]);
      expect(audit.rows).toHaveLength(1);
      expect(audit.rows[0].action).toBe('campaign.close');
      expect(audit.rows[0].details).toMatchObject({ ballots, receipts, match: true });
      // and a vote after the close committed is refused
      await voters[0].post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(409);
      expect(await count('ballots', c.id)).toBe(ballots);
    }
  });

  it('deterministic interleaving: a close fired right after a vote read "open" cannot let that ballot slip in after the close counted', async () => {
    const c = await openCampaign('Interleave');
    const s = await login(app, S1);
    let closeRes: Promise<request.Response> | undefined;
    let fired = false;
    testHooks.afterCampaignRead = async () => {
      if (fired) return;
      fired = true;
      closeRes = Promise.resolve(c.admin.post(`/api/campaigns/${c.id}/close`));   // close arrives mid-vote...
      await new Promise((r) => setTimeout(r, 400));                                 // ...and has time to finish IF nothing stops it
    };
    try {
      const vote = await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] });
      expect((await closeRes!).status).toBe(200);
      expect([201, 409]).toContain(vote.status);
      const ballots = await count('ballots', c.id);
      const receipts = await count('vote_receipts', c.id);
      expect(receipts).toBe(ballots);
      expect(ballots).toBe(vote.status === 201 ? 1 : 0);
      const audit = await ownerDb().query("SELECT details FROM audit_log WHERE campaign_id = $1 AND action = 'campaign.close'", [c.id]);
      // The close counted exactly what finally exists: no ballot committed after it.
      expect(audit.rows[0].details).toMatchObject({ ballots, receipts, match: true });
    } finally { testHooks.afterCampaignRead = undefined; }
  });

  it('auto-close (closes_at passed) under concurrent votes closes exactly once and refuses every vote', async () => {
    const c = await openCampaign('Auto race');
    await ownerDb().query("UPDATE campaigns SET closes_at = now() - interval '1 second' WHERE id = $1", [c.id]);
    const sessions = await Promise.all([S1, S2, S3].map((u) => login(app, u)));
    const rs = await Promise.all(sessions.flatMap((s) => [0, 1].map(() => s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }))));
    expect(rs.map((r) => r.status)).toEqual([409, 409, 409, 409, 409, 409]);
    expect(rs.every((r) => r.body.code === 'closed')).toBe(true);
    const audit = await ownerDb().query("SELECT details FROM audit_log WHERE campaign_id = $1 AND action = 'campaign.close'", [c.id]);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].details).toMatchObject({ reason: 'auto', ballots: 0, receipts: 0, match: true });
    expect(await count('ballots', c.id)).toBe(0);
  });
});

describe('sharing: the link and QR carry only the random share token', () => {
  it('share_url, QR and poster encode /v/<share_token> and never the campaign id or any session/voter data', async () => {
    const c = await openCampaign('Share me');
    const spy = vi.spyOn(QRCode, 'toBuffer');
    try {
      const detail = (await c.admin.get(`/api/campaigns/${c.id}`).expect(200)).body;
      expect(detail.share_url).toBe(`http://localhost:5173/v/${c.token}`);
      expect(c.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      expect(detail.share_url).not.toContain(c.id);

      await c.admin.get(`/api/campaigns/${c.id}/qr.png`).expect(200);
      await c.admin.get(`/api/campaigns/${c.id}/poster.pdf`).expect(200);
      expect(spy).toHaveBeenCalledTimes(2);
      for (const call of spy.mock.calls) {
        const encoded = String(call[0]);
        expect(encoded).toBe(`http://localhost:5173/v/${c.token}`);
        for (const secret of [c.id, ADMIN_A.oid, ADMIN_A.email, 'namra_session', 'csrf']) expect(encoded).not.toContain(secret);
      }
    } finally { spy.mockRestore(); }
  });

  it('previewing the QR is not audited; the explicit download is', async () => {
    const c = await openCampaign('QR audit');
    const n = async () => (await ownerDb().query("SELECT count(*)::int AS n FROM audit_log WHERE campaign_id = $1 AND action = 'qr.download'", [c.id])).rows[0].n as number;
    await c.admin.get(`/api/campaigns/${c.id}/qr.png`).expect(200);
    expect(await n()).toBe(0);
    const dl = await c.admin.get(`/api/campaigns/${c.id}/qr.png?download=1`).expect(200);
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(await n()).toBe(1);
  });
});

describe('ballot secrecy walk', () => {
  it('no API response in a full happy-path run contains both a voter identifier and a candidate id', async () => {
    responseLog.length = 0;
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2, 'Walk');
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const voters = [S1, S2, S3];
    for (const [i, u] of voters.entries()) {
      const s = await login(app, u);
      await s.get('/api/vote').expect(200);
      await s.get(`/api/vote/${c.token}`).expect(200);
      await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[i % 2] }).expect(201);
      await s.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(409);     // retry
      await s.get(`/api/vote/${c.token}`).expect(200);
    }
    await admin.get(`/api/campaigns/${c.id}`).expect(200);
    await admin.get(`/api/campaigns/${c.id}/results`).expect(200);
    await admin.get('/api/campaigns/mine').expect(200);
    await admin.get('/api/campaigns/summary').expect(200);
    await admin.post(`/api/campaigns/${c.id}/close`).expect(200);
    await admin.post(`/api/campaigns/${c.id}/publish`).expect(200);
    await admin.get(`/api/campaigns/${c.id}/results.csv`).expect(200);
    await admin.get(`/api/campaigns/summary`).expect(200);
    const s1 = await login(app, S1);
    await s1.get(`/api/vote/${c.token}/results`).expect(200);

    const voterIds = voters.flatMap((u) => [u.oid, u.email]);
    expect(responseLog.length).toBeGreaterThan(30);
    expect(responseLog.some((r) => c.candidates.some((id) => r.body.includes(id)))).toBe(true);    // the walk is meaningful...
    expect(responseLog.some((r) => voterIds.some((id) => r.body.includes(id)))).toBe(true);        // ...on both sides
    for (const r of responseLog) {
      const hasVoter = voterIds.some((id) => r.body.includes(id));
      const hasCandidate = c.candidates.some((id) => r.body.includes(id));
      expect(hasVoter && hasCandidate, `${r.url} mixes a voter identifier with a candidate id`).toBe(false);
    }
    // and the database agrees: no column links them
    const dump = JSON.stringify((await ownerDb().query('SELECT * FROM tallies')).rows);
    expect(voterIds.some((id) => dump.includes(id))).toBe(false);
    void anonymous; void request;
  });
});
