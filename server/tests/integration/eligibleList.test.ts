// Eligible-list hardening (migration 023): the database refuses changes to a started vote's list, except through the audited late-add and
// retention paths; the list is fingerprinted in the audit trail; a bad entry is reported, not fatal; and leavers are marked, not removed.
import crypto from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { eligibleListHash } from '../../src/domain/eligibility.js';
import { ADMIN_A, ADMIN_B, S1, S2, S3, TEST_APP_URL, closeOwner, login, ownerDb, resetDb, sessionFor, setMembers } from '../helpers.js';
import { pgc } from '../testDb.js';

const app = createApp();
let appRole: pg.Pool;
beforeEach(async () => { await resetDb(); appRole ??= new pg.Pool({ ...pgc(TEST_APP_URL), max: 2 }); });
afterAll(async () => { await appRole?.end(); await closePool(); await closeOwner(); });

type Admin = Awaited<ReturnType<typeof login>>;
const REASON = 'Joined the organisation after voting began';

async function listed(admin: Admin, emails: string[], start = true) {
  const c = (await admin.post('/api/campaigns').send({ title: 'Listed vote', eligibility: 'list', emails }).expect(201)).body;
  const cands: string[] = [];
  for (const n of ['One', 'Two']) cands.push((await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', n).expect(201)).body.id);
  if (start) await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
  return { id: c.id as string, token: c.share_token as string, cands };
}
const audits = async (id: string, action: string) => (await ownerDb().query('SELECT actor_oid, details FROM audit_log WHERE campaign_id = $1 AND action = $2 ORDER BY seq', [id, action])).rows;
const dbHash = async (id: string) => (await ownerDb().query('SELECT eligible_list_sha256($1) AS h', [id])).rows[0].h as string;

/** Runs sql as the given pool inside one transaction (so a set_config is in force for the statement after it), and returns the error, if any. */
async function inTx(pool: pg.Pool, ...stmts: [string, unknown[]?][]): Promise<{ code?: string; message?: string } | null> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const [sql, p] of stmts) await c.query(sql, p);
    await c.query('COMMIT');
    return null;
  } catch (e) { await c.query('ROLLBACK').catch(() => undefined); return e as { code?: string; message?: string }; } finally { c.release(); }
}

describe('the database guards the list of a started vote', () => {
  it('a draft list is edited freely through the API', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await listed(admin, [S1.email], false);
    await admin.put(`/api/campaigns/${c.id}/eligible`).send({ mode: 'list', emails: [S1.email, S2.email] }).expect(200);
    await admin.put(`/api/campaigns/${c.id}/eligible`).send({ mode: 'list', emails: [S3.email] }).expect(200);
    expect((await ownerDb().query('SELECT voter_email FROM eligible_voters WHERE campaign_id = $1', [c.id])).rows).toEqual([{ voter_email: S3.email }]);
  });

  it('once started, INSERT and DELETE are refused for the app role AND for the owner', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await listed(admin, [S1.email]);
    for (const [who, pool] of [['app', appRole], ['owner', ownerDb()]] as const) {
      const ins = await inTx(pool, ['INSERT INTO eligible_voters (campaign_id, voter_email) VALUES ($1, $2)', [c.id, S2.email]]);
      expect(ins, `${who} insert`).toMatchObject({ code: '23514', message: expect.stringMatching(/locked/) });
      const del = await inTx(pool, ['DELETE FROM eligible_voters WHERE campaign_id = $1', [c.id]]);
      expect(del, `${who} delete`).toMatchObject({ code: '23514', message: expect.stringMatching(/locked/) });
    }
    expect((await ownerDb().query('SELECT voter_email FROM eligible_voters WHERE campaign_id = $1', [c.id])).rows).toEqual([{ voter_email: S1.email }]);
  });

  it('an address cannot be rewritten, and the leaver mark cannot be set by the app', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await listed(admin, [S1.email]);
    expect(await inTx(ownerDb(), ['UPDATE eligible_voters SET voter_email = $2 WHERE campaign_id = $1', [c.id, S2.email]])).toMatchObject({ code: '23514' });
    expect(await inTx(ownerDb(), ['UPDATE eligible_voters SET left_at = now() WHERE campaign_id = $1', [c.id]])).toMatchObject({ code: '23514' });   // owner without the retention reason
    expect(await inTx(appRole, ['UPDATE eligible_voters SET left_at = now() WHERE campaign_id = $1', [c.id]])).toMatchObject({ code: '42501' });     // no UPDATE right on it
  });

  it('the app role cannot switch the guard off for itself, whatever it sets', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await listed(admin, [S1.email]);
    const ins = await inTx(appRole, ["SELECT set_config('namra.eligible_bypass', 'late_add', true)"], ['INSERT INTO eligible_voters (campaign_id, voter_email) VALUES ($1, $2)', [c.id, S2.email]]);
    expect(ins).toMatchObject({ code: '23514' });
    await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
    await admin.post(`/api/campaigns/${c.id}/archive`).expect(200);
    const del = await inTx(appRole, ["SELECT set_config('namra.eligible_bypass', 'retention', true)"], ['DELETE FROM eligible_voters WHERE campaign_id = $1', [c.id]]);
    expect(del).toMatchObject({ code: '23514' });
  });

  it('the retention reason works for the owner only on a closed AND archived campaign', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await listed(admin, [S1.email]);
    const bypass: [string] = ["SELECT set_config('namra.eligible_bypass', 'retention', true)"];
    expect(await inTx(ownerDb(), bypass, ['DELETE FROM eligible_voters WHERE campaign_id = $1', [c.id]])).toMatchObject({ code: '23514' });   // open
    await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
    expect(await inTx(ownerDb(), bypass, ['DELETE FROM eligible_voters WHERE campaign_id = $1', [c.id]])).toMatchObject({ code: '23514' });   // closed, not archived
    await admin.post(`/api/campaigns/${c.id}/archive`).expect(200);
    expect(await inTx(ownerDb(), bypass, ['DELETE FROM eligible_voters WHERE campaign_id = $1', [c.id]])).toBeNull();
  });

  it('permanently deleting an archived campaign still removes its list (it goes with the campaign)', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await listed(admin, [S1.email]);
    await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
    await admin.get(`/api/campaigns/${c.id}/results.csv`).expect(200);
    await admin.post(`/api/campaigns/${c.id}/archive`).expect(200);
    await admin.post(`/api/campaigns/${c.id}/permanent-delete`).send({ confirm_title: 'Listed vote' }).expect(200);
    expect((await ownerDb().query('SELECT count(*)::int AS n FROM eligible_voters WHERE campaign_id = $1', [c.id])).rows[0].n).toBe(0);
  });
});

describe('late add (the audited way into a running list)', () => {
  it('works through the API, is audited with the list fingerprint, and the new voter can vote', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await listed(admin, [S1.email]);
    await admin.post(`/api/campaigns/${c.id}/late-voters`).send({ email: S2.email, reason: REASON }).expect(201);
    const a = (await audits(c.id, 'voter.late_added'))[0];
    expect(a.details).toMatchObject({ mode: 'list', email: S2.email, reason: REASON, list_count: 2, list_sha256: eligibleListHash([S1.email, S2.email]) });
    expect(a.details.list_sha256).toBe(await dbHash(c.id));
    await (await login(app, S2)).post(`/api/vote/${c.token}`).send({ candidateId: c.cands[0] }).expect(201);
  });

  it('is the creator only, an open campaign only, and a real reason, all re-checked in the database from the live session', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await listed(admin, [S1.email]);
    const call = (session: string, email = S2.email, reason = REASON) => appRole.query('SELECT late_add_eligible($1, $2, $3, $4) AS r', [c.id, session, email, reason]);
    await expect(call('not-a-session')).rejects.toMatchObject({ code: 'NR401' });
    await expect(call(await sessionFor(ADMIN_B))).rejects.toMatchObject({ code: 'NR404' });                 // someone else's campaign
    await expect(call(await sessionFor(ADMIN_A), S2.email, 'short')).rejects.toMatchObject({ code: 'NR400' });
    await expect(call(await sessionFor(ADMIN_A), 'not an address')).rejects.toMatchObject({ code: 'NR400' });
    expect((await call(await sessionFor(ADMIN_A))).rows[0].r).toMatchObject({ inserted: true });
    expect((await call(await sessionFor(ADMIN_A))).rows[0].r).toEqual({ inserted: false });                 // already listed
    await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
    await expect(call(await sessionFor(ADMIN_A), S3.email)).rejects.toMatchObject({ code: 'NR409' });       // closed
  });

  it('cannot be used on a draft or a vote that is not a list vote', async () => {
    const admin = await login(app, ADMIN_A);
    const draft = await listed(admin, [S1.email], false);
    await expect(appRole.query('SELECT late_add_eligible($1, $2, $3, $4)', [draft.id, await sessionFor(ADMIN_A), S2.email, REASON])).rejects.toMatchObject({ code: 'NR409' });
    const all = (await admin.post('/api/campaigns').send({ title: 'All staff', eligibility: 'all' }).expect(201)).body;
    for (const n of ['One', 'Two']) await admin.post(`/api/campaigns/${all.id}/candidates`).field('name', n).expect(201);
    await admin.post(`/api/campaigns/${all.id}/start`).expect(200);
    await expect(appRole.query('SELECT late_add_eligible($1, $2, $3, $4)', [all.id, await sessionFor(ADMIN_A), S2.email, REASON])).rejects.toMatchObject({ code: 'NR409' });
  });
});

describe('the SHA-256 of the sorted list is in the audit trail', () => {
  it('the JS and SQL definitions agree: lower-case, sorted byte-wise, joined by line feeds, duplicates once', async () => {
    const admin = await login(app, ADMIN_A);
    const emails = ['zed@namra.org.na', 'Amy@namra.org.na', 'amy@namra.org.na', 'bob@namra.org.na'];
    const c = await listed(admin, emails, false);
    const want = crypto.createHash('sha256').update('amy@namra.org.na\nbob@namra.org.na\nzed@namra.org.na', 'utf8').digest('hex');
    expect(await dbHash(c.id)).toBe(want);
    expect(eligibleListHash(emails)).toBe(want);
  });

  it('eligibility.set and campaign.start record it; it changes when the list does', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await listed(admin, [S1.email], false);
    const put = (await admin.put(`/api/campaigns/${c.id}/eligible`).send({ mode: 'list', emails: [S2.email, S1.email] }).expect(200)).body;
    expect(put.list_sha256).toBe(eligibleListHash([S1.email, S2.email]));
    const set = await audits(c.id, 'eligibility.set');
    expect(set[set.length - 1].details).toMatchObject({ mode: 'list', count: 2, list_sha256: eligibleListHash([S1.email, S2.email]) });
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    expect((await audits(c.id, 'campaign.start'))[0].details).toMatchObject({ eligible_count: 2, list_sha256: eligibleListHash([S1.email, S2.email]) });
    await admin.post(`/api/campaigns/${c.id}/late-voters`).send({ email: S3.email, reason: REASON }).expect(201);
    expect(await dbHash(c.id)).not.toBe(eligibleListHash([S1.email, S2.email]));
  });

  it('the admin sees the fingerprint on the campaign', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await listed(admin, [S1.email, S2.email], false);
    expect((await admin.get(`/api/campaigns/${c.id}`).expect(200)).body.eligible_summary).toMatchObject({ count: 2, left: 0, sha256: eligibleListHash([S1.email, S2.email]) });
  });

  it('an Umoja campaign records the fingerprint of the frozen active members at start', async () => {
    const admin = await login(app, ADMIN_A);
    await setMembers([['NAM0002', true], ['NAM0001', true], ['NAM0003', false]]);
    const c = (await admin.post('/api/campaigns').send({ title: 'Umoja vote', eligibility: 'umoja' }).expect(201)).body;
    for (const n of ['One', 'Two']) await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', n).expect(201);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const want = crypto.createHash('sha256').update('NAM0001\nNAM0002', 'utf8').digest('hex');
    expect((await audits(c.id, 'campaign.start'))[0].details).toMatchObject({ frozen_members: 3, list_sha256: want });
  });
});

describe('a bad entry is reported, not fatal', () => {
  it('saves the valid addresses and names exactly the invalid and non-@namra.org.na entries', async () => {
    const admin = await login(app, ADMIN_A);
    await login(app, S1);                                                    // S1 has signed in; S2 never has
    const c = await listed(admin, [S1.email], false);
    const r = (await admin.put(`/api/campaigns/${c.id}/eligible`).send({ mode: 'list', emails: [S1.email, 'typo-here', 'guest@gmail.com', S2.email.toUpperCase(), ' ', 'a@b', S1.email] }).expect(200)).body;
    expect(r).toMatchObject({ mode: 'list', count: 3 });
    expect(r.warnings.invalid).toEqual(['typo-here', 'a@b']);
    expect(r.warnings.not_namra).toEqual(expect.arrayContaining(['guest@gmail.com']));
    expect(r.warnings.never_signed_in).toEqual(expect.arrayContaining([S2.email, 'guest@gmail.com']));
    expect(r.warnings.never_signed_in).not.toContain(S1.email);
    expect((await ownerDb().query('SELECT voter_email FROM eligible_voters WHERE campaign_id = $1 ORDER BY voter_email', [c.id])).rows.map((x) => x.voter_email))
      .toEqual([S1.email, S2.email, 'guest@gmail.com'].sort());
    expect((await audits(c.id, 'eligibility.set')).pop()!.details).toMatchObject({ count: 3, skipped_invalid: 2 });
  });

  it('a list with no valid address at all is refused (it would wipe the list), naming the entries', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await listed(admin, [S1.email], false);
    const r = await admin.put(`/api/campaigns/${c.id}/eligible`).send({ mode: 'list', emails: ['nope', 'also nope'] }).expect(400);
    expect(r.body.code).toBe('no_valid_emails'); expect(r.body.error).toContain('nope');
    expect((await ownerDb().query('SELECT count(*)::int AS n FROM eligible_voters WHERE campaign_id = $1', [c.id])).rows[0].n).toBe(1);   // untouched
  });

  it('creating a campaign with a bad entry saves the rest and says what was skipped', async () => {
    const admin = await login(app, ADMIN_A);
    const r = (await admin.post('/api/campaigns').send({ title: 'T', eligibility: 'list', emails: [S1.email, 'broken', 'x@other.org'] }).expect(201)).body;
    expect(r.eligible_warnings).toMatchObject({ invalid: ['broken'], not_namra: ['x@other.org'] });
    expect((await ownerDb().query('SELECT count(*)::int AS n FROM eligible_voters WHERE campaign_id = $1', [r.id])).rows[0].n).toBe(2);
  });

  it('the campaign page shows the count of listed addresses that have never signed in, and not the ones who have', async () => {
    const admin = await login(app, ADMIN_A);
    await login(app, S1);
    const c = await listed(admin, [S1.email, S2.email, S3.email], false);
    const s = (await admin.get(`/api/campaigns/${c.id}`).expect(200)).body.eligible_summary;
    expect(s.never_signed_in).toEqual([S2.email, S3.email].sort());
    expect(s.not_namra).toEqual(expect.arrayContaining([S1.email]));   // the test addresses are @namra.test, so they are flagged too
    await login(app, S2);
    expect((await admin.get(`/api/campaigns/${c.id}`).expect(200)).body.eligible_summary.never_signed_in).toEqual([S3.email]);
  });
});
