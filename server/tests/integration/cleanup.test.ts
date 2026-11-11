import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { readPhoto } from '../../src/services/images.js';
import { testHooks } from '../../src/services/voting.js';
import { ADMIN_A, ADMIN_B, S1, S2, TEST_APP_URL, closeOwner, login, ownerDb, png, resetDb, type Session } from '../helpers.js';

const app = createApp();
const TITLE = 'Cleanup Vote 2026';
const REASON = 'Ballot box stuffed during a demo';
let appRole: pg.Pool;

beforeEach(async () => { await resetDb(); appRole ??= new pg.Pool({ connectionString: TEST_APP_URL, max: 2 }); });
afterEach(() => { testHooks.afterCampaignRead = undefined; });
afterAll(async () => { await appRole?.end(); await closePool(); await closeOwner(); });

type Stage = 'draft' | 'open' | 'closed' | 'archived';
interface Fx { id: string; token: string; cands: string[]; photos: string[] }

/** Two candidates (one with a photo), everyone eligible, advanced to the requested stage. */
async function fixture(admin: Session, stage: Stage, title = TITLE): Promise<Fx> {
  const c = (await admin.post('/api/campaigns').send({ title }).expect(201)).body;
  await admin.put(`/api/campaigns/${c.id}/eligible`).send({ mode: 'all' }).expect(200);
  const a = (await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', 'Alpha Person').attach('photo', await png(200, 200), { filename: 'a.png', contentType: 'image/png' }).expect(201)).body;
  const b = (await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', 'Bravo Person').attach('photo', await png(120, 90), { filename: 'b.png', contentType: 'image/png' }).expect(201)).body;
  const photos = (await ownerDb().query('SELECT photo_path FROM candidates WHERE campaign_id = $1', [c.id])).rows.map((r) => r.photo_path as string);
  if (stage !== 'draft') await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
  if (stage === 'closed' || stage === 'archived') await admin.post(`/api/campaigns/${c.id}/close`).expect(200);
  if (stage === 'archived') await admin.post(`/api/campaigns/${c.id}/archive`).expect(200);
  return { id: c.id, token: c.share_token, cands: [a.id, b.id], photos };
}

const rowCount = async (table: string, id: string, col = 'campaign_id') => (await ownerDb().query(`SELECT count(*)::int n FROM ${table} WHERE ${col} = $1`, [id])).rows[0].n as number;
const exists = async (id: string) => (await rowCount('campaigns', id, 'id')) === 1;
const audits = async (id: string, action: string) => (await ownerDb().query('SELECT * FROM audit_log WHERE campaign_id = $1 AND action = $2 ORDER BY id', [id, action])).rows;
const photosPresent = async (f: Fx) => (await Promise.all(f.photos.map((p) => readPhoto(p)))).map((b) => b !== null);
const archivedAt = async (id: string) => (await ownerDb().query('SELECT archived_at FROM campaigns WHERE id = $1', [id])).rows[0]?.archived_at as Date | null | undefined;
function vote(s: Session, f: Fx, i = 0) { return s.post(`/api/vote/${f.token}`).send({ candidateId: f.cands[i] }); }

describe('delete a draft', () => {
  it('POSITIVE CONTROL: the creator deletes a draft: campaign, candidates, eligibility and the photo files are gone; audited', async () => {
    const A = await login(app, ADMIN_A);
    const f = await fixture(A, 'draft');
    expect(await photosPresent(f)).toEqual([true, true]);
    await A.del(`/api/campaigns/${f.id}`).expect(204);
    expect(await exists(f.id)).toBe(false);
    expect(await rowCount('candidates', f.id)).toBe(0);
    expect(await rowCount('eligible_voters', f.id)).toBe(0);
    expect(await photosPresent(f)).toEqual([false, false]);
    const [a] = await audits(f.id, 'campaign.delete_draft');
    expect(a.actor_oid).toBe(ADMIN_A.oid);
    expect(a.details).toEqual({ title: TITLE, candidates: 2 });
    expect((await audits(f.id, 'campaign.create')).length).toBe(1);   // the audit log itself keeps its history
    await A.get(`/api/campaigns/${f.id}`).expect(404);
  });

  it('an open campaign cannot be deleted ("Close the campaign first"); a closed one is not a draft', async () => {
    const A = await login(app, ADMIN_A);
    const open = await fixture(A, 'open');
    const r = await A.del(`/api/campaigns/${open.id}`).expect(409);
    expect(r.body).toMatchObject({ error: 'Close the campaign first', code: 'open_campaign' });
    expect(await exists(open.id)).toBe(true);
    expect(await photosPresent(open)).toEqual([true, true]);
    const closed = await fixture(A, 'closed', 'Closed one');
    expect((await A.del(`/api/campaigns/${closed.id}`).expect(409)).body.code).toBe('not_draft');
    expect(await exists(closed.id)).toBe(true);
  });

  it('a non-admin gets 403', async () => {
    const A = await login(app, ADMIN_A);
    const f = await fixture(A, 'draft');
    await (await login(app, S1)).del(`/api/campaigns/${f.id}`).expect(403);
    expect(await exists(f.id)).toBe(true);
  });
});

describe('archive / unarchive', () => {
  it('only closed campaigns can be archived: open says "Close the campaign first", drafts are refused', async () => {
    const A = await login(app, ADMIN_A);
    const open = await fixture(A, 'open');
    expect((await A.post(`/api/campaigns/${open.id}/archive`).expect(409)).body).toMatchObject({ error: 'Close the campaign first', code: 'open_campaign' });
    const draft = await fixture(A, 'draft', 'A draft');
    expect((await A.post(`/api/campaigns/${draft.id}/archive`).expect(409)).body.code).toBe('not_closed');
    expect(await archivedAt(open.id)).toBeNull();
    expect(await archivedAt(draft.id)).toBeNull();
    // the database enforces it too (owner role, bypassing the app)
    await expect(ownerDb().query('UPDATE campaigns SET archived_at = now() WHERE id = $1', [open.id])).rejects.toThrow(/campaigns_archive_only_closed/);
  });

  it('POSITIVE CONTROL: archive moves a closed campaign out of the tabs and stats; results stay viewable and exportable; unarchive restores it', async () => {
    const A = await login(app, ADMIN_A);
    const f = await fixture(A, 'open');
    await vote(await login(app, S1), f, 0).expect(201);
    await A.post(`/api/campaigns/${f.id}/close`).expect(200);
    const before = (await A.get('/api/campaigns/summary').expect(200)).body;
    expect(before.closed.map((c: { id: string }) => c.id)).toEqual([f.id]);
    expect(before.archived).toEqual([]);

    await A.post(`/api/campaigns/${f.id}/archive`).expect(200);
    expect(await archivedAt(f.id)).toBeInstanceOf(Date);
    const after = (await A.get('/api/campaigns/summary').expect(200)).body;
    expect(after.closed).toEqual([]);
    expect(after.counts.archived).toBe(1);
    expect(after.archived.map((c: { id: string; winner: { name: string } }) => [c.id, c.winner.name])).toEqual([[f.id, 'Alpha Person']]);
    expect((await A.get('/api/campaigns/mine').expect(200)).body.campaigns[0].archived_at).toBeTruthy();   // the dashboard buckets on this
    const res = (await A.get(`/api/campaigns/${f.id}/results`).expect(200)).body;
    expect(res).toMatchObject({ status: 'closed', archived: true });
    expect(res.candidates.find((c: { name: string }) => c.name === 'Alpha Person').votes).toBe(1);
    expect((await A.get(`/api/campaigns/${f.id}/results.csv`).expect(200)).text).toContain('Alpha Person');
    await A.post(`/api/campaigns/${f.id}/archive`).expect(409);                // already archived

    await A.post(`/api/campaigns/${f.id}/unarchive`).expect(200);
    expect(await archivedAt(f.id)).toBeNull();
    expect((await A.get('/api/campaigns/summary')).body.closed.map((c: { id: string }) => c.id)).toEqual([f.id]);
    await A.post(`/api/campaigns/${f.id}/unarchive`).expect(409);              // not archived

    expect((await audits(f.id, 'campaign.archive'))[0]).toMatchObject({ actor_oid: ADMIN_A.oid, details: { title: TITLE } });
    expect((await audits(f.id, 'campaign.unarchive'))[0]).toMatchObject({ actor_oid: ADMIN_A.oid, details: { title: TITLE } });
  });
});

describe('another admin sees nothing: every action answers 404 and changes nothing', () => {
  it.each<[string, Stage, 'del' | 'post', string, object | undefined]>([
    ['delete draft', 'draft', 'del', '', undefined],
    ['archive', 'closed', 'post', '/archive', undefined],
    ['unarchive', 'archived', 'post', '/unarchive', undefined],
    ['permanent delete', 'archived', 'post', '/permanent-delete', { confirm_title: TITLE }],
    ['reset', 'open', 'post', '/reset', { confirm_title: TITLE, reason: REASON }],
  ])('%s', async (_n, stage, verb, suffix, body) => {
    const A = await login(app, ADMIN_A);
    const B = await login(app, ADMIN_B);
    const f = await fixture(A, stage);
    const r = await (verb === 'del' ? B.del(`/api/campaigns/${f.id}${suffix}`) : B.post(`/api/campaigns/${f.id}${suffix}`).send(body ?? {}));
    expect(r.status).toBe(404);
    expect(await exists(f.id)).toBe(true);
    expect(await rowCount('candidates', f.id)).toBe(2);
    expect(await photosPresent(f)).toEqual([true, true]);
    expect(((await ownerDb().query('SELECT status, archived_at FROM campaigns WHERE id = $1', [f.id])).rows[0])).toMatchObject({ status: stage === 'archived' ? 'closed' : stage });
    const denied = (await ownerDb().query("SELECT actor_oid FROM audit_log WHERE campaign_id = $1 AND action = 'authz.denied'", [f.id])).rows;
    expect(denied.some((d) => d.actor_oid === ADMIN_B.oid)).toBe(true);
  });
});

describe('permanent delete', () => {
  it('is refused unless the campaign is archived (open, draft, merely closed), even with the right title', async () => {
    const A = await login(app, ADMIN_A);
    for (const stage of ['draft', 'open', 'closed'] as const) {
      const f = await fixture(A, stage, `T ${stage}`);
      const r = await A.post(`/api/campaigns/${f.id}/permanent-delete`).send({ confirm_title: `T ${stage}` }).expect(409);
      expect(r.body.code).toBe('not_archived');
      expect(await exists(f.id)).toBe(true);
      expect(await photosPresent(f)).toEqual([true, true]);
    }
  });

  it('a wrong, differently-cased, padded or missing title is refused and nothing is deleted', async () => {
    const A = await login(app, ADMIN_A);
    const f = await fixture(A, 'archived');
    for (const t of ['wrong', TITLE.toLowerCase(), TITLE + ' ', ' ' + TITLE, '']) {
      expect((await A.post(`/api/campaigns/${f.id}/permanent-delete`).send({ confirm_title: t }).expect(400)).body.code, JSON.stringify(t)).toBe('title_mismatch');
    }
    await A.post(`/api/campaigns/${f.id}/permanent-delete`).send({}).expect(400);
    await A.post(`/api/campaigns/${f.id}/permanent-delete`).send({ confirm_title: TITLE, extra: 1 }).expect(400);
    expect(await exists(f.id)).toBe(true);
    expect(await photosPresent(f)).toEqual([true, true]);
  });

  it('POSITIVE CONTROL: with the exact title it removes ballots, receipts, candidates, eligibility, the campaign and the photos; the audit log keeps counts only', async () => {
    const A = await login(app, ADMIN_A);
    const f = await fixture(A, 'open');
    await vote(await login(app, S1), f, 0).expect(201);
    await vote(await login(app, S2), f, 1).expect(201);
    await A.post(`/api/campaigns/${f.id}/close`).expect(200);
    await A.post(`/api/campaigns/${f.id}/archive`).expect(200);
    expect(await rowCount('ballots', f.id)).toBe(2);

    const r = await A.post(`/api/campaigns/${f.id}/permanent-delete`).send({ confirm_title: TITLE }).expect(200);
    expect(r.body).toEqual({ deleted: true, ballots_removed: 2, receipts_removed: 2 });
    for (const t of ['ballots', 'vote_receipts', 'candidates', 'eligible_voters']) expect(await rowCount(t, f.id), t).toBe(0);
    expect(await exists(f.id)).toBe(false);
    expect(await photosPresent(f)).toEqual([false, false]);

    const [a] = await audits(f.id, 'campaign.delete_permanent');
    expect(a.actor_oid).toBe(ADMIN_A.oid);
    expect(a.details).toEqual({ title: TITLE, ballots_removed: 2, receipts_removed: 2, candidates_removed: 2 });
    const all = JSON.stringify((await ownerDb().query('SELECT * FROM audit_log WHERE campaign_id = $1', [f.id])).rows);
    expect(all).not.toContain(S1.oid); expect(all).not.toContain(S2.oid); expect(all).not.toContain(S1.email);
    expect((await audits(f.id, 'campaign.create')).length).toBe(1);   // earlier entries survive: the audit log is never deleted
    expect((await audits(f.id, 'campaign.archive')).length).toBe(1);
  });
});

describe('the app role cannot delete directly; only the SECURITY DEFINER functions can, and they re-check everything', () => {
  it('namra_app has no DELETE or UPDATE on ballots, vote_receipts, audit_log, campaigns, umoja_members', async () => {
    const A = await login(app, ADMIN_A);
    await fixture(A, 'archived');
    for (const t of ['ballots', 'vote_receipts', 'audit_log', 'campaigns', 'umoja_members']) {
      await expect(appRole.query(`DELETE FROM ${t}`), `DELETE ${t}`).rejects.toThrow(/permission denied/);
    }
    for (const t of ['ballots', 'vote_receipts', 'audit_log']) {
      const p = (await ownerDb().query("SELECT has_table_privilege('namra_app', $1, 'DELETE') d, has_table_privilege('namra_app', $1, 'UPDATE') u, has_table_privilege('namra_app', $1, 'TRUNCATE') t", [t])).rows[0];
      expect(p, t).toEqual({ d: false, u: false, t: false });
    }
    await expect(appRole.query('TRUNCATE ballots')).rejects.toThrow(/permission denied/);
  });

  it('the functions are owned by the owner role, executable by namra_app and NOT by PUBLIC', async () => {
    const rows = (await ownerDb().query(
      `SELECT proname, pg_get_userbyid(proowner) AS owner, prosecdef, proacl::text AS acl FROM pg_proc
        WHERE proname IN ('delete_draft_campaign','delete_archived_campaign','reset_campaign_votes') ORDER BY proname`)).rows;
    expect(rows.map((r) => r.proname)).toEqual(['delete_archived_campaign', 'delete_draft_campaign', 'reset_campaign_votes']);
    for (const r of rows) {
      expect(r.owner).toBe('namra_owner');
      expect(r.prosecdef).toBe(true);
      expect(r.acl).toContain('namra_app=X/namra_owner');
      expect(r.acl).not.toMatch(/(^\{|,)=X\//);   // no PUBLIC grant
    }
  });

  it('called directly (bypassing the API), delete_archived_campaign still refuses: not archived, not the creator', async () => {
    const A = await login(app, ADMIN_A);
    const closed = await fixture(A, 'closed');
    await expect(appRole.query('SELECT delete_archived_campaign($1, $2)', [closed.id, ADMIN_A.oid])).rejects.toMatchObject({ code: 'NR409' });
    const archived = await fixture(A, 'archived', 'Archived two');
    await expect(appRole.query('SELECT delete_archived_campaign($1, $2)', [archived.id, ADMIN_B.oid])).rejects.toMatchObject({ code: 'NR404' });
    await expect(appRole.query('SELECT delete_archived_campaign($1, $2)', ['00000000-0000-4000-8000-000000000000', ADMIN_A.oid])).rejects.toMatchObject({ code: 'NR404' });
    await expect(appRole.query('SELECT delete_draft_campaign($1, $2)', [closed.id, ADMIN_A.oid])).rejects.toMatchObject({ code: 'NR409' });
    expect(await exists(closed.id)).toBe(true);
    expect(await exists(archived.id)).toBe(true);
    // POSITIVE CONTROL: the same call with the right actor on the archived campaign works.
    const out = (await appRole.query('SELECT delete_archived_campaign($1, $2) AS r', [archived.id, ADMIN_A.oid])).rows[0].r;
    expect(out).toMatchObject({ ballots: 0, receipts: 0, candidates: 2 });
    expect(await exists(archived.id)).toBe(false);
  });
});

describe('reset votes', () => {
  const resetBody = (o: object = {}) => ({ confirm_title: TITLE, reason: REASON, ...o });

  it('POSITIVE CONTROL: clears receipts and ballots, re-opens, and the same user can vote again; candidates, photos and eligibility stay', async () => {
    const A = await login(app, ADMIN_A);
    const f = await fixture(A, 'open');
    const s1 = await login(app, S1); const s2 = await login(app, S2);
    await vote(s1, f, 0).expect(201); await vote(s2, f, 1).expect(201);
    await vote(s1, f, 0).expect(409);                                                      // already voted
    expect((await s1.get(`/api/vote/${f.token}`)).body.voterState).toBe('already_voted');
    expect((await A.get(`/api/campaigns/${f.id}`)).body.turnout).toBe(2);

    const r = await A.post(`/api/campaigns/${f.id}/reset`).send(resetBody()).expect(200);
    expect(r.body).toEqual({ status: 'open', votes_cleared: 2 });
    expect(await rowCount('ballots', f.id)).toBe(0);
    expect(await rowCount('vote_receipts', f.id)).toBe(0);
    expect(await rowCount('candidates', f.id)).toBe(2);
    expect(await photosPresent(f)).toEqual([true, true]);
    expect((await s1.get(`/api/vote/${f.token}`)).body.voterState).toBe('can_vote');     // previous voters can vote again
    await vote(s1, f, 1).expect(201);
    await vote(s1, f, 1).expect(409);
    expect(await rowCount('ballots', f.id)).toBe(1);
    expect(await rowCount('vote_receipts', f.id)).toBe(1);
  });

  it('re-opens a CLOSED campaign (unpublishing the results); a passed closing time needs a new one', async () => {
    const A = await login(app, ADMIN_A);
    const f = await fixture(A, 'open');
    await vote(await login(app, S1), f, 0).expect(201);
    await A.post(`/api/campaigns/${f.id}/close`).expect(200);
    await A.post(`/api/campaigns/${f.id}/publish`).expect(200);
    await ownerDb().query("UPDATE campaigns SET closes_at = now() - interval '1 hour' WHERE id = $1", [f.id]);
    const needNew = await A.post(`/api/campaigns/${f.id}/reset`).send(resetBody()).expect(409);
    expect(needNew.body.code).toBe('needs_new_close');
    expect(await rowCount('ballots', f.id)).toBe(1);                                       // nothing happened
    await A.post(`/api/campaigns/${f.id}/reset`).send(resetBody({ closes_at: new Date(Date.now() - 3600_000).toISOString() })).expect(400);   // must be in the future
    const later = new Date(Date.now() + 2 * 3600_000).toISOString();
    await A.post(`/api/campaigns/${f.id}/reset`).send(resetBody({ closes_at: later })).expect(200);
    const row = (await ownerDb().query('SELECT status, results_published, closes_at FROM campaigns WHERE id = $1', [f.id])).rows[0];
    expect(row.status).toBe('open');
    expect(row.results_published).toBe(false);
    expect(new Date(row.closes_at).toISOString()).toBe(later);
    await vote(await login(app, S1), f, 0).expect(201);                                    // can vote again
    expect((await audits(f.id, 'campaign.reset'))[0].details.previous_status).toBe('closed');
  });

  it('writes a permanent audit entry with the reason and a counts-only snapshot, shown in the Reset history', async () => {
    const A = await login(app, ADMIN_A);
    const f = await fixture(A, 'open');
    const s1 = await login(app, S1); const s2 = await login(app, S2);
    await vote(s1, f, 0).expect(201); await vote(s2, f, 0).expect(201);
    await A.post(`/api/campaigns/${f.id}/reset`).send(resetBody()).expect(200);

    const [a] = await audits(f.id, 'campaign.reset');
    expect(a.actor_oid).toBe(ADMIN_A.oid);
    expect(a.at).toBeInstanceOf(Date);
    expect(a.details).toEqual({
      reason: REASON, previous_status: 'open', new_closes_at: null,
      snapshot: { candidates: [{ name: 'Alpha Person', votes: 2 }, { name: 'Bravo Person', votes: 0 }], turnout: { votes: 2, ballots: 2 } },
    });
    const raw = JSON.stringify(a);
    expect(raw).not.toContain(S1.oid); expect(raw).not.toContain(S2.oid); expect(raw).not.toContain(S1.email);

    // creator's Results tab: who, when, why, and the per-candidate snapshot
    const h = (await A.get(`/api/campaigns/${f.id}/results`).expect(200)).body.resets;
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ by: 'Alice Admin', reason: REASON, votes_cleared: 2, candidates: [{ name: 'Alpha Person', votes: 2 }, { name: 'Bravo Person', votes: 0 }] });
    expect(new Date(h[0].at).getTime()).toBeGreaterThan(Date.now() - 60_000);

    // a second reset appends; voters who can see the published results see the history (without per-candidate counts)
    await vote(s1, f, 1).expect(201);
    await A.post(`/api/campaigns/${f.id}/reset`).send(resetBody({ reason: 'Second reset after another test run' })).expect(200);
    await vote(s2, f, 1).expect(201);
    await A.post(`/api/campaigns/${f.id}/close`).expect(200);
    await A.post(`/api/campaigns/${f.id}/publish`).expect(200);
    const seen = (await s1.get(`/api/vote/${f.token}/results`).expect(200)).body.resets;
    expect(seen.map((x: { reason: string }) => x.reason)).toEqual([REASON, 'Second reset after another test run']);
    expect(seen[0]).toMatchObject({ by: 'Alice Admin', votes_cleared: 2 });
    expect(seen[0]).not.toHaveProperty('candidates');
    expect(((await audits(f.id, 'campaign.reset')).length)).toBe(2);
  });

  it('requires the exact title AND a reason of at least 10 characters; otherwise nothing changes', async () => {
    const A = await login(app, ADMIN_A);
    const f = await fixture(A, 'open');
    await vote(await login(app, S1), f, 0).expect(201);
    const bad: [string, object][] = [
      ['no title', { reason: REASON }], ['no reason', { confirm_title: TITLE }], ['empty body', {}],
      ['wrong title', resetBody({ confirm_title: 'nope' })], ['title in other case', resetBody({ confirm_title: TITLE.toUpperCase() })],
      ['9-char reason', resetBody({ reason: '123456789' })], ['blank reason', resetBody({ reason: '          ' })], ['unknown field', resetBody({ x: 1 })],
    ];
    for (const [name, body] of bad) { expect((await A.post(`/api/campaigns/${f.id}/reset`).send(body)).status, name).toBe(400); }
    expect(await rowCount('ballots', f.id)).toBe(1);
    expect(await rowCount('vote_receipts', f.id)).toBe(1);
    expect((await audits(f.id, 'campaign.reset')).length).toBe(0);
    // the database re-checks the reason too
    await expect(appRole.query('SELECT reset_campaign_votes($1, $2, $3)', [f.id, ADMIN_A.oid, 'too short'])).rejects.toMatchObject({ code: 'NR400' });
    await expect(appRole.query('SELECT reset_campaign_votes($1, $2, $3)', [f.id, ADMIN_B.oid, REASON])).rejects.toMatchObject({ code: 'NR404' });
    expect(await rowCount('ballots', f.id)).toBe(1);
  });

  it('cannot reset an archived campaign or a draft', async () => {
    const A = await login(app, ADMIN_A);
    const arch = await fixture(A, 'archived');
    expect((await A.post(`/api/campaigns/${arch.id}/reset`).send(resetBody()).expect(409)).body.code).toBe('archived');
    await expect(appRole.query('SELECT reset_campaign_votes($1, $2, $3)', [arch.id, ADMIN_A.oid, REASON])).rejects.toMatchObject({ code: 'NR409' });
    const draft = await fixture(A, 'draft', 'Draft one');
    expect((await A.post(`/api/campaigns/${draft.id}/reset`).send(resetBody({ confirm_title: 'Draft one' })).expect(409)).body.code).toBe('not_started');
    // after unarchiving it works (POSITIVE CONTROL)
    await A.post(`/api/campaigns/${arch.id}/unarchive`).expect(200);
    await A.post(`/api/campaigns/${arch.id}/reset`).send(resetBody()).expect(200);
  });

  it('a reset during a vote in flight is one transaction: receipts always equal ballots', async () => {
    const A = await login(app, ADMIN_A);
    const f = await fixture(A, 'open');
    const s1 = await login(app, S1); const s2 = await login(app, S2);
    await vote(s1, f, 0).expect(201);

    // Hold S2's vote open right after it read the campaign row (it now holds FOR SHARE on it).
    let release!: () => void; let reached!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const atHook = new Promise<void>((r) => { reached = r; });
    let first = true;
    testHooks.afterCampaignRead = async () => { if (first) { first = false; reached(); await gate; } };
    const inFlight = vote(s2, f, 1).then((r) => r);
    await atHook;

    let resetDone = false;
    const reset = A.post(`/api/campaigns/${f.id}/reset`).send(resetBody()).then((r) => { resetDone = true; return r; });
    await new Promise((r) => setTimeout(r, 400));
    expect(resetDone, 'the reset must wait for the in-flight vote (it needs FOR UPDATE on the campaign row)').toBe(false);

    release();
    const [v, rs] = await Promise.all([inFlight, reset]);
    expect(v.status).toBe(201);
    expect(rs.status).toBe(200);
    expect(rs.body.votes_cleared).toBe(2);                                                  // the in-flight vote was counted, then wiped with the rest
    const ballots = await rowCount('ballots', f.id); const receipts = await rowCount('vote_receipts', f.id);
    expect(ballots).toBe(receipts);
    expect(ballots).toBe(0);
    const snap = (await audits(f.id, 'campaign.reset'))[0].details.snapshot;
    expect(snap.turnout).toEqual({ votes: 2, ballots: 2 });

    // And a vote racing the other way (started while the reset holds the lock) ends up consistent too.
    const results = await Promise.all([vote(s1, f, 0), A.post(`/api/campaigns/${f.id}/reset`).send(resetBody({ reason: 'Another reset, racing a vote' })), vote(s2, f, 1)]);
    expect(results[1].status).toBe(200);
    expect(await rowCount('ballots', f.id)).toBe(await rowCount('vote_receipts', f.id));
  });
});
