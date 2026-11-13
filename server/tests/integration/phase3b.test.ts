import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { ADMIN_A, ADMIN_B, S1, S2, TEST_APP_URL, closeOwner, login, makeCampaign, ownerDb, resetDb, sessionFor } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

const NOTE = 'Checked the database: one receipt row was inserted by hand';

async function openWithVotes(title = 'Integrity vote', closesInPast = false) {
  const admin = await login(app, ADMIN_A);
  const c = await makeCampaign(admin, 2, title);
  await admin.patch(`/api/campaigns/${c.id}`).send({ closes_at: new Date(Date.now() + 3600_000).toISOString() }).expect(200);
  await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
  await (await login(app, S1)).post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(201);
  await (await login(app, S2)).post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[1] }).expect(201);
  if (closesInPast) await ownerDb().query("UPDATE campaigns SET closes_at = now() - interval '1 minute' WHERE id = $1", [c.id]);
  return { admin, ...c };
}
const tamper = (id: string, cand: string, by = 1) => ownerDb().query('UPDATE tallies SET votes = votes + $3 WHERE campaign_id = $1 AND candidate_id = $2', [id, cand, by]);
const status = async (id: string) => (await ownerDb().query('SELECT status, results_published FROM campaigns WHERE id = $1', [id])).rows[0];
const auditCount = async (id: string, action: string) => (await ownerDb().query('SELECT count(*)::int n FROM audit_log WHERE campaign_id = $1 AND action = $2', [id, action])).rows[0].n as number;

describe('SEC-16: receipts != tallies blocks close and publish until an admin investigates', () => {
  it('a manual close is refused, the campaign stays open, and the block is recorded once', async () => {
    const c = await openWithVotes();
    await tamper(c.id, c.candidates[0]);
    const r = await c.admin.post(`/api/campaigns/${c.id}/close`).send({ reason: 'Everyone has voted already' }).expect(409);
    expect(r.body.code).toBe('integrity_mismatch');
    expect(r.body.error).toMatch(/Receipts \(2\) and tallies \(3\) do not match/);
    expect((await status(c.id)).status).toBe('open');
    await c.admin.post(`/api/campaigns/${c.id}/close`).send({ reason: 'Everyone has voted already' }).expect(409);
    expect(await auditCount(c.id, 'campaign.integrity.blocked')).toBe(1);               // not one row per attempt
    expect(await auditCount(c.id, 'campaign.close')).toBe(0);
    expect(await auditCount(c.id, 'campaign.close.INTEGRITY_MISMATCH')).toBe(0);
    const detail = (await c.admin.get(`/api/campaigns/${c.id}`).expect(200)).body;
    expect(detail.integrity_block).toMatchObject({ ballots: 3, receipts: 2 });
  });

  it('acknowledging needs a note, needs a block, and then lets the close through; the seal records the acknowledgement', async () => {
    const c = await openWithVotes();
    await c.admin.post(`/api/campaigns/${c.id}/integrity/acknowledge`).send({ note: NOTE }).expect(409);        // nothing to acknowledge yet
    await tamper(c.id, c.candidates[0]);
    await c.admin.post(`/api/campaigns/${c.id}/close`).send({ reason: 'Everyone has voted already' }).expect(409);
    await c.admin.post(`/api/campaigns/${c.id}/integrity/acknowledge`).send({ note: 'short' }).expect(400);
    await c.admin.post(`/api/campaigns/${c.id}/integrity/acknowledge`).send({}).expect(400);
    expect((await status(c.id)).status).toBe('open');
    await c.admin.post(`/api/campaigns/${c.id}/integrity/acknowledge`).send({ note: NOTE }).expect(200);
    expect((await c.admin.get(`/api/campaigns/${c.id}`).expect(200)).body.integrity_block).toBeNull();
    const closed = (await c.admin.post(`/api/campaigns/${c.id}/close`).send({ reason: 'Everyone has voted already' }).expect(200)).body;
    expect(closed.integrity).toEqual({ ballots: 3, receipts: 2, match: false });
    const seal = (await ownerDb().query("SELECT action, details FROM audit_log WHERE campaign_id = $1 AND action LIKE 'campaign.close%'", [c.id])).rows;
    expect(seal).toHaveLength(1);
    expect(seal[0].action).toBe('campaign.close.INTEGRITY_MISMATCH');
    expect(seal[0].details).toMatchObject({ acknowledged: true, ballots: 3, receipts: 2 });
    const ack = (await ownerDb().query("SELECT actor_oid, details FROM audit_log WHERE campaign_id = $1 AND action = 'campaign.integrity.ack'", [c.id])).rows[0];
    expect(ack.actor_oid).toBe(ADMIN_A.oid);
    expect(ack.details.note).toBe(NOTE);
  });

  it('only the creator can acknowledge', async () => {
    const c = await openWithVotes();
    await tamper(c.id, c.candidates[0]);
    await c.admin.post(`/api/campaigns/${c.id}/close`).send({ reason: 'Everyone has voted already' }).expect(409);
    const other = await login(app, ADMIN_B);
    await other.post(`/api/campaigns/${c.id}/integrity/acknowledge`).send({ note: NOTE }).expect(404);
    expect((await c.admin.get(`/api/campaigns/${c.id}`).expect(200)).body.integrity_block).not.toBeNull();
  });

  it('the automatic close at the closing time is blocked the same way, without breaking the ballot page or flooding the audit log', async () => {
    const c = await openWithVotes('Auto integrity', true);
    await tamper(c.id, c.candidates[1], 2);
    const voter = await login(app, S1);
    for (let i = 0; i < 4; i++) await voter.get(`/api/vote/${c.token}`).expect(200);         // page views each try the lazy close
    expect((await status(c.id)).status).toBe('open');
    expect(await auditCount(c.id, 'campaign.integrity.blocked')).toBe(1);
    expect(await auditCount(c.id, 'campaign.close')).toBe(0);
    await voter.post(`/api/vote/${c.token}`).send({ candidateId: c.candidates[0] }).expect(409);   // voting is shut by the closing time anyway
  });

  it('control: with matching counts nothing is blocked', async () => {
    const c = await openWithVotes();
    await c.admin.post(`/api/campaigns/${c.id}/close`).send({ reason: 'Everyone has voted already' }).expect(200);
    expect(await auditCount(c.id, 'campaign.integrity.blocked')).toBe(0);
  });

  it('a closed result that no longer matches its seal cannot be published (and can once it matches again)', async () => {
    const c = await openWithVotes();
    await c.admin.post(`/api/campaigns/${c.id}/close`).send({ reason: 'Everyone has voted already' }).expect(200);
    await tamper(c.id, c.candidates[0], 5);
    const r = await c.admin.post(`/api/campaigns/${c.id}/publish`).expect(409);
    expect(r.body.code).toBe('integrity_failed');
    expect((await status(c.id)).results_published).toBe(false);
    await tamper(c.id, c.candidates[0], -5);
    await c.admin.post(`/api/campaigns/${c.id}/publish`).expect(200);
  });
});

describe('SEC-17: clean-up functions take the actor from a live session, and the database enforces the state machine', () => {
  async function app_(): Promise<pg.Client> { const db = new pg.Client({ connectionString: TEST_APP_URL }); await db.connect(); return db; }
  async function archivedCampaign() {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2, 'Trusted actor');
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    await admin.post(`/api/campaigns/${c.id}/close`).expect(200);
    await admin.post(`/api/campaigns/${c.id}/archive`).expect(200);
    return { admin, ...c };
  }

  it('the old actor-argument signatures are gone: an actor id is no longer an accepted credential', async () => {
    const c = await archivedCampaign();
    const db = await app_();
    try {
      await expect(db.query('SELECT delete_archived_campaign($1, $2::uuid)', [c.id, ADMIN_A.oid])).rejects.toThrow(/does not exist/);
      await expect(db.query('SELECT delete_archived_campaign($1, $2)', [c.id, ADMIN_A.oid])).rejects.toMatchObject({ code: 'NR401' });   // as text it is just a bad session id
    } finally { await db.end(); }
    expect((await ownerDb().query('SELECT 1 FROM campaigns WHERE id = $1', [c.id])).rowCount).toBe(1);
  });

  it('no session, an unknown session, an expired one and a revoked one are all refused; another user\'s session finds nothing', async () => {
    const c = await archivedCampaign();
    const db = await app_();
    try {
      const del = (sess: string | null) => db.query('SELECT delete_archived_campaign($1, $2)', [c.id, sess]);
      await expect(del(null)).rejects.toMatchObject({ code: 'NR401' });
      await expect(del('not-a-session')).rejects.toMatchObject({ code: 'NR401' });
      await expect(del(await sessionFor(ADMIN_A, { ttlSeconds: -60 }))).rejects.toMatchObject({ code: 'NR401' });
      await expect(del(await sessionFor(ADMIN_A, { revoked: true }))).rejects.toMatchObject({ code: 'NR401' });
      await expect(del(await sessionFor(ADMIN_B))).rejects.toMatchObject({ code: 'NR404' });           // a live session, but not the creator's
      expect((await ownerDb().query('SELECT 1 FROM campaigns WHERE id = $1', [c.id])).rowCount).toBe(1);
      // POSITIVE CONTROL: the creator's live session works
      const out = (await del(await sessionFor(ADMIN_A))).rows[0].delete_archived_campaign;
      expect(out.candidates).toBe(2);
      expect((await ownerDb().query('SELECT 1 FROM campaigns WHERE id = $1', [c.id])).rowCount).toBe(0);
      expect((await ownerDb().query("SELECT actor_oid FROM audit_log WHERE action = 'campaign.delete_permanent'")).rows[0].actor_oid).toBe(ADMIN_A.oid);   // actor derived from the session
    } finally { await db.end(); }
  });

  it('the session lookup itself is not callable by the app role, and the functions pin their search_path', async () => {
    const db = await app_();
    try { await expect(db.query("SELECT session_actor('x')")).rejects.toThrow(/permission denied/); } finally { await db.end(); }
    const rows = (await ownerDb().query("SELECT proname, proconfig::text AS cfg, prosecdef FROM pg_proc WHERE proname IN ('delete_draft_campaign','delete_archived_campaign','reset_campaign_votes','session_actor')")).rows;
    expect(rows).toHaveLength(4);
    for (const r of rows) { expect(r.prosecdef, r.proname).toBe(true); expect(r.cfg, r.proname).toMatch(/search_path=pg_catalog, public, pg_temp/); }
  });

  it('through the API the actor still comes from the caller\'s session (and a demoted or signed-out caller cannot reset)', async () => {
    const c = await archivedCampaign();
    await c.admin.post(`/api/campaigns/${c.id}/unarchive`).expect(200);
    await ownerDb().query('UPDATE sessions SET revoked_at = now()');
    const dead = await c.admin.post(`/api/campaigns/${c.id}/reset`).send({ confirm_title: 'Trusted actor', reason: 'Trying with a dead session' });
    expect([401, 403]).toContain(dead.status);                                   // refused (the session-bound CSRF token already fails)
    expect((await status(c.id)).status).toBe('closed');
  });

  it('the app role cannot break the state machine with plain SQL', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2, 'State machine');
    const db = await app_();
    const upd = (sql: string, ...p: unknown[]) => db.query(sql, [c.id, ...p]);
    try {
      await expect(upd("UPDATE campaigns SET status = 'closed' WHERE id = $1")).rejects.toThrow(/illegal status change draft -> closed/);   // must be started first
      await expect(upd('UPDATE campaigns SET created_by = $2 WHERE id = $1', S1.oid)).rejects.toThrow(/cannot change/);
      await expect(upd("UPDATE campaigns SET share_token = repeat('z', 40) WHERE id = $1")).rejects.toThrow(/cannot change/);
      await expect(upd('UPDATE campaigns SET results_published = true WHERE id = $1')).rejects.toThrow(/only be published for a closed campaign/);
      await upd("UPDATE campaigns SET title = 'edited while draft' WHERE id = $1");                  // allowed in a draft
      await upd("UPDATE campaigns SET status = 'open' WHERE id = $1");                               // draft -> open
      await expect(upd("UPDATE campaigns SET title = 'edited while open' WHERE id = $1")).rejects.toThrow(/is locked/);
      await expect(upd("UPDATE campaigns SET eligibility = 'list' WHERE id = $1")).rejects.toThrow(/is locked/);
      await expect(upd("UPDATE campaigns SET closes_at = now() + interval '1 day' WHERE id = $1")).rejects.toThrow(/is locked/);
      await expect(upd("UPDATE campaigns SET status = 'draft' WHERE id = $1")).rejects.toThrow(/illegal status change open -> draft/);
      await expect(upd("UPDATE campaigns SET archived_at = now() WHERE id = $1")).rejects.toThrow(/only a closed campaign can be archived|campaigns_archive_only_closed/);
      await upd("UPDATE campaigns SET status = 'closed' WHERE id = $1");                             // open -> closed
      await expect(upd("UPDATE campaigns SET status = 'open' WHERE id = $1")).rejects.toThrow(/illegal status change closed -> open/);   // only the reset function may reopen
      await expect(upd("UPDATE campaigns SET status = 'draft' WHERE id = $1")).rejects.toThrow(/illegal status change closed -> draft/);
      await upd('UPDATE campaigns SET results_published = true, published_at = now(), published_by = $2 WHERE id = $1', ADMIN_A.oid);   // closed: may publish (the publication guard needs who and when, migration 018)
      await expect(upd('UPDATE campaigns SET results_published = false WHERE id = $1')).rejects.toThrow(/cannot be withdrawn/);
      await upd('UPDATE campaigns SET archived_at = now() WHERE id = $1');                           // closed: may archive
    } finally { await db.end(); }
  });

  it('the one way back from closed to open is the reset function, and it still works', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2, 'Reopen via reset');
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    await admin.post(`/api/campaigns/${c.id}/close`).expect(200);
    await admin.post(`/api/campaigns/${c.id}/publish`).expect(200);
    await admin.post(`/api/campaigns/${c.id}/reset`).send({ confirm_title: 'Reopen via reset', reason: 'Re-run after a counting error', closes_at: new Date(Date.now() + 3600_000).toISOString() }).expect(200);
    expect(await status(c.id)).toEqual({ status: 'open', results_published: false });
  });
});
