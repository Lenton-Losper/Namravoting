// Pick range per position, the optional region vote rule, the required candidate region, and their audit trail (migration 024).
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { ADMIN_A, S1, S2, S3, S4, S5, closeOwner, login, makeElection, ownerDb, resetDb, type Election } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

type Sess = Awaited<ReturnType<typeof login>>;
const KH = 'Khomas', ER = 'Erongo', OH = 'Ohangwena';

/** One position "Additional Members": 3 candidates from Khomas, 3 from elsewhere. Not started. */
async function members(extra: { seats?: number; min?: number; max?: number; rule?: { n: number; region: string } | null; abstain?: boolean; start?: boolean } = {}) {
  const admin = await login(app, ADMIN_A);
  const e = await makeElection(admin, {
    abstain: extra.abstain,
    positions: [{ title: 'Additional Members', seats: extra.seats ?? 4, candidates: [
      { name: 'K1', region: KH }, { name: 'K2', region: KH }, { name: 'K3', region: KH },
      { name: 'E1', region: ER }, { name: 'O1', region: OH }, { name: 'E2', region: ER }] }],
  });
  const patch: Record<string, unknown> = {};
  if (extra.min !== undefined) patch.min_picks = extra.min;
  if (extra.max !== undefined) patch.max_picks = extra.max;
  if (extra.rule !== undefined) patch.region_rule = extra.rule ? { min_outside: extra.rule.n, region_id: e.regions[extra.rule.region] } : null;
  if (Object.keys(patch).length) await admin.patch(`/api/campaigns/${e.id}/positions/${e.positions[0].id}`).send(patch).expect(200);
  if (extra.start) await admin.post(`/api/campaigns/${e.id}/start`).expect(200);
  return { e, admin };
}
const ids = (e: Election, ...names: string[]) => names.map((n) => e.positions[0].candidates.find((c) => c.name === n)!.id);
const vote = (s: Sess, e: Election, body: object) => s.post(`/api/vote/${e.token}/positions/${e.positions[0].id}`).send(body);
const receipts = async (e: Election) => (await ownerDb().query('SELECT count(*)::int AS n FROM vote_receipts WHERE campaign_id = $1', [e.id])).rows[0].n as number;
const audits = async (id: string, action: string) => (await ownerDb().query('SELECT details FROM audit_log WHERE campaign_id = $1 AND action = $2 ORDER BY seq', [id, action])).rows;
const block = async (admin: Sess, e: Election) => ((await admin.get(`/api/campaigns/${e.id}/positions`).expect(200)).body.positions as Record<string, any>[])[0];

describe('the pick range', () => {
  it('a position keeps the old behaviour by default: min = max = the number of winners, "Choose N"', async () => {
    const { e, admin } = await members();
    expect(await block(admin, e)).toMatchObject({ seats: 4, min_picks: 4, max_picks: 4, choose_label: 'Choose 4', region_rule: null });
  });
  it('a range is stored and labelled "Choose up to 4"; winners (seats) stay as they were', async () => {
    const { e, admin } = await members({ min: 1, max: 4 });
    expect(await block(admin, e)).toMatchObject({ seats: 4, min_picks: 1, max_picks: 4, choose_label: 'Choose up to 4' });
  });
  it('changing only the number of winners keeps an exact count in step with it', async () => {
    const { e, admin } = await members({ seats: 2 });
    await admin.patch(`/api/campaigns/${e.id}/positions/${e.positions[0].id}`).send({ seats: 3 }).expect(200);
    expect(await block(admin, e)).toMatchObject({ seats: 3, min_picks: 3, max_picks: 3 });
  });
  it('refuses a minimum above the maximum', async () => {
    const { e, admin } = await members();
    expect((await admin.patch(`/api/campaigns/${e.id}/positions/${e.positions[0].id}`).send({ min_picks: 5, max_picks: 3 }).expect(400)).body.code).toBe('bad_picks');
  });
  it('the vote enforces the range: up to 4 takes 1 to 4 picks; none or five is refused and writes nothing', async () => {
    const { e } = await members({ min: 1, max: 4, start: true });
    const s = await login(app, S1);
    expect((await vote(s, e, { candidateIds: ids(e, 'K1', 'K2', 'K3', 'E1', 'O1') }).expect(400)).body.code).toBe('wrong_number');
    expect(await receipts(e)).toBe(0);
    await vote(s, e, { candidateIds: ids(e, 'E1') }).expect(201);
    await vote(await login(app, S2), e, { candidateIds: ids(e, 'K1', 'K2', 'E1', 'O1') }).expect(201);
    expect(await receipts(e)).toBe(2);
  });
  it('the ballot data carries the range, the label and no rule', async () => {
    const { e } = await members({ min: 1, max: 4, start: true });
    const b = (await (await login(app, S1)).get(`/api/vote/${e.token}/positions/${e.positions[0].id}`).expect(200)).body;
    expect(b.position).toMatchObject({ minPicks: 1, maxPicks: 4, chooseLabel: 'Choose up to 4', regionRule: null });
  });
});

describe('the region rule: saving', () => {
  it('is stored as data, with its generated sentence', async () => {
    const { e, admin } = await members({ rule: { n: 2, region: KH } });
    expect((await block(admin, e)).region_rule).toEqual({ min_outside: 2, region_id: e.regions[KH], region: KH, text: 'At least 2 picks from outside Khomas' });
    expect((await ownerDb().query('SELECT region_rule_min, region_rule_region_id FROM positions WHERE id = $1', [e.positions[0].id])).rows[0]).toEqual({ region_rule_min: 2, region_rule_region_id: e.regions[KH] });
  });
  it('N cannot be above the most a voter can pick', async () => {
    const { e, admin } = await members({ min: 1, max: 2 });
    const r = await admin.patch(`/api/campaigns/${e.id}/positions/${e.positions[0].id}`).send({ region_rule: { min_outside: 3, region_id: e.regions[KH] } }).expect(400);
    expect(r.body.code).toBe('rule_exceeds_picks');
  });
  it('the region must belong to this campaign', async () => {
    const { e, admin } = await members();
    const other = await makeElection(admin, { title: 'Other', positions: [{ title: 'P', candidates: ['x', 'y'] }] });
    const r = await admin.patch(`/api/campaigns/${e.id}/positions/${e.positions[0].id}`).send({ region_rule: { min_outside: 1, region_id: other.regions[KH] } }).expect(400);
    expect(r.body.code).toBe('invalid_region');
  });
  it('the rule can be cleared', async () => {
    const { e, admin } = await members({ rule: { n: 2, region: KH } });
    await admin.patch(`/api/campaigns/${e.id}/positions/${e.positions[0].id}`).send({ region_rule: null }).expect(200);
    expect((await block(admin, e)).region_rule).toBeNull();
  });
  it('a region that a rule names cannot be removed', async () => {
    const { e, admin } = await members({ rule: { n: 2, region: KH } });
    const r = await admin.del(`/api/campaigns/${e.id}/regions/${e.regions[KH]}`);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await ownerDb().query('SELECT count(*)::int AS n FROM regions WHERE id = $1', [e.regions[KH]])).rows[0].n).toBe(1);
  });
});

describe('the region rule: "Ready to start?"', () => {
  it('fails while too few approved candidates stand outside the region, and passes once there are enough', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'Additional Members', seats: 4, candidates: [{ name: 'K1', region: KH }, { name: 'K2', region: KH }, { name: 'K3', region: KH }, { name: 'E1', region: ER }, { name: 'K4', region: KH }] }] });
    await admin.patch(`/api/campaigns/${e.id}/positions/${e.positions[0].id}`).send({ region_rule: { min_outside: 2, region_id: e.regions[KH] } }).expect(200);
    const r = await admin.post(`/api/campaigns/${e.id}/start`).expect(409);
    expect(r.body.error).toContain('At least 2 picks from outside Khomas');
    expect(r.body.error).toContain('only 1 approved candidate is outside Khomas');
    await admin.post(`/api/campaigns/${e.id}/candidates`).field('region', OH).field('name', 'O1').field('position_id', e.positions[0].id).expect(201);
    await admin.post(`/api/campaigns/${e.id}/start`).expect(200);
  });
  it('fails when voters must pick more candidates than are approved', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'P', seats: 3, candidates: ['a', 'b'] }] });
    const r = await admin.post(`/api/campaigns/${e.id}/start`).expect(409);
    expect(r.body.error).toMatch(/at least 3, but only 2/);
  });
});

describe('the region rule: voting', () => {
  it('refuses a ballot that breaks the rule with 409 and a clear message, and writes nothing', async () => {
    const { e } = await members({ rule: { n: 2, region: KH }, start: true });
    const s = await login(app, S1);
    const r = await vote(s, e, { candidateIds: ids(e, 'K1', 'K2', 'K3', 'E1') }).expect(409);
    expect(r.body.code).toBe('region_rule');
    expect(r.body.error).toContain('At least 2 picks from outside Khomas');
    expect(await receipts(e)).toBe(0);
    expect((await ownerDb().query('SELECT coalesce(sum(votes), 0)::int AS n FROM tallies WHERE campaign_id = $1', [e.id])).rows[0].n).toBe(0);
  });
  it('accepts a ballot that meets it, with 4 picks, and the same voter cannot vote again', async () => {
    const { e } = await members({ rule: { n: 2, region: KH }, start: true });
    const s = await login(app, S1);
    await vote(s, e, { candidateIds: ids(e, 'K1', 'K2', 'E1', 'O1') }).expect(201);
    await vote(s, e, { candidateIds: ids(e, 'K1', 'K2', 'E1', 'O1') }).expect(409);
  });
  it('is judged for every route: the plain /api/vote/:token with positionId too', async () => {
    const { e } = await members({ rule: { n: 2, region: KH }, start: true });
    const s = await login(app, S1);
    const r = await s.post(`/api/vote/${e.token}`).send({ candidateIds: ids(e, 'K1', 'K2', 'K3', 'E1'), positionId: e.positions[0].id }).expect(409);
    expect(r.body.code).toBe('region_rule');
  });
  it('abstain is still allowed when the campaign allows it', async () => {
    const { e } = await members({ rule: { n: 2, region: KH }, abstain: true, start: true });
    const abst = (await ownerDb().query('SELECT id FROM candidates WHERE position_id = $1 AND is_abstain', [e.positions[0].id])).rows[0].id as string;
    await vote(await login(app, S1), e, { candidateIds: [abst] }).expect(201);
  });
  it('with a range: up to 4 and at least 2 from outside Khomas', async () => {
    const { e } = await members({ min: 1, max: 4, rule: { n: 2, region: KH }, start: true });
    await vote(await login(app, S1), e, { candidateIds: ids(e, 'E1', 'O1') }).expect(201);
    expect((await vote(await login(app, S2), e, { candidateIds: ids(e, 'K1', 'E1') }).expect(409)).body.code).toBe('region_rule');
    expect((await vote(await login(app, S3), e, { candidateIds: ids(e, 'K1') }).expect(409)).body.code).toBe('region_rule');
  });
  it('the ballot data carries the rule as data and as a sentence', async () => {
    const { e } = await members({ rule: { n: 2, region: KH }, start: true });
    const s = await login(app, S1);
    const one = (await s.get(`/api/vote/${e.token}/positions/${e.positions[0].id}`).expect(200)).body.position;
    expect(one.regionRule).toEqual({ minOutside: 2, regionId: expect.any(String), regionName: KH, text: 'At least 2 picks from outside Khomas' });
    const all = (await s.get(`/api/vote/${e.token}`).expect(200)).body.positions[0];
    expect(all.regionRule.text).toBe('At least 2 picks from outside Khomas');
  });
  it('closing works with the receipt/counter check: votes of different sizes and an abstain keep the totals in range', async () => {
    const { e, admin } = await members({ min: 1, max: 4, abstain: true, start: true });
    const abst = (await ownerDb().query('SELECT id FROM candidates WHERE position_id = $1 AND is_abstain', [e.positions[0].id])).rows[0].id as string;
    await vote(await login(app, S1), e, { candidateIds: ids(e, 'K1') }).expect(201);
    await vote(await login(app, S2), e, { candidateIds: ids(e, 'K1', 'K2', 'E1', 'O1') }).expect(201);
    await vote(await login(app, S3), e, { candidateIds: [abst] }).expect(201);
    await admin.post(`/api/campaigns/${e.id}/close`).send({ reason: 'Closing for the test run' }).expect(200);
    expect((await admin.get(`/api/campaigns/${e.id}/verify`).expect(200)).body).toMatchObject({ chain_ok: true, sealed: true });
  });
  it('the rule does not decide winners: the top `seats` win whatever the rule was', async () => {
    const { e, admin } = await members({ seats: 2, min: 1, max: 4, rule: { n: 1, region: KH }, start: true });
    for (const [u, picks] of [[S1, ['K1', 'E1']], [S2, ['K1', 'E1']], [S3, ['K1', 'K2', 'E1']], [S4, ['K1', 'K2', 'E1']], [S5, ['K1', 'O1']]] as const) await vote(await login(app, u), e, { candidateIds: ids(e, ...picks) }).expect(201);
    await admin.post(`/api/campaigns/${e.id}/close`).send({ reason: 'Closing for the test run' }).expect(200);
    const r = (await admin.get(`/api/campaigns/${e.id}/results`).expect(200)).body;
    const names = (r.positions[0].winners as { name: string }[]).map((w) => w.name).sort();
    expect(names).toEqual(['E1', 'K1']);   // K1 (5 votes) and E1 (4), by votes alone
  });
});

describe('every candidate has a region', () => {
  it('the API refuses a candidate without one, and one that is not in this campaign', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'P', candidates: ['a', 'b'] }] });
    const url = `/api/campaigns/${e.id}/candidates`;
    expect((await admin.post(url).field('name', 'No region').field('position_id', e.positions[0].id).expect(400)).body.issues?.[0]?.message ?? '').toMatch(/region/i);
    expect((await admin.post(url).field('region', 'Atlantis').field('name', 'X').field('position_id', e.positions[0].id).expect(400)).body.code).toBe('invalid_region');
    await admin.post(url).field('region', 'Erongo').field('name', 'Ok').field('position_id', e.positions[0].id).expect(201);
  });
  it('a candidate\'s region can be changed but not cleared', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'P', candidates: [{ name: 'a', region: KH }, 'b'] }] });
    const cid = e.positions[0].candidates[0].id;
    await admin.patch(`/api/campaigns/${e.id}/candidates/${cid}`).field('region_id', e.regions[ER]).expect(200);
    expect((await admin.patch(`/api/campaigns/${e.id}/candidates/${cid}`).field('region_id', '').expect(400)).body.code).toBe('region_required');
  });
  it('the database refuses a candidate without a region, for any role (the Abstain line is the exception)', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { abstain: true, positions: [{ title: 'P', candidates: ['a', 'b'] }] });
    await expect(ownerDb().query("INSERT INTO candidates (campaign_id, position_id, name) VALUES ($1, $2, 'No region')", [e.id, e.positions[0].id])).rejects.toThrow(/needs a region/);
    expect((await ownerDb().query('SELECT count(*)::int AS n FROM candidates WHERE position_id = $1 AND is_abstain', [e.positions[0].id])).rows[0].n).toBe(1);
  });
  it('existing region-less candidates are kept, but the campaign cannot start until each has a region (API and database)', async () => {
    const admin = await login(app, ADMIN_A);
    const e = await makeElection(admin, { positions: [{ title: 'P', candidates: ['a', 'b'] }] });
    // simulate a candidate from before this migration
    await ownerDb().query('ALTER TABLE candidates DISABLE TRIGGER candidates_region_required');
    try { await ownerDb().query('UPDATE candidates SET region_id = NULL WHERE id = $1', [e.positions[0].candidates[0].id]); } finally { await ownerDb().query('ALTER TABLE candidates ENABLE TRIGGER candidates_region_required'); }
    const r = await admin.post(`/api/campaigns/${e.id}/start`).expect(409);
    expect(r.body.error).toMatch(/every candidate needs a region.*a/);
    await expect(ownerDb().query("UPDATE campaigns SET status = 'open' WHERE id = $1", [e.id])).rejects.toThrow(/no region/);
    expect((await ownerDb().query('SELECT count(*)::int AS n FROM candidates WHERE campaign_id = $1', [e.id])).rows[0].n).toBe(2);   // nothing deleted
    await expect(ownerDb().query("UPDATE candidates SET name = 'a2' WHERE id = $1", [e.positions[0].candidates[0].id])).rejects.toThrow(/needs a region/);   // cannot be saved in a draft without one
    await admin.patch(`/api/campaigns/${e.id}/candidates/${e.positions[0].candidates[0].id}`).field('region', ER).expect(200);
    await admin.post(`/api/campaigns/${e.id}/start`).expect(200);
  });
  it('the region cannot change once voting has started, even when edits after start are allowed', async () => {
    const admin = await login(app, ADMIN_A);
    const c = (await admin.post('/api/campaigns').send({ title: 'Edits', eligibility: 'all', allow_edits_after_start: true }).expect(201)).body;
    const cands: string[] = [];
    for (const n of ['a', 'b']) cands.push((await admin.post(`/api/campaigns/${c.id}/candidates`).field('region', KH).field('name', n).expect(201)).body.id);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const regions = (await admin.get(`/api/campaigns/${c.id}/regions`).expect(200)).body.regions as { id: string; name: string }[];
    const er = regions.find((x) => x.name === ER)!.id;
    expect((await admin.patch(`/api/campaigns/${c.id}/candidates/${cands[0]}`).field('region_id', er).expect(409)).body.code).toBe('region_locked');
    await expect(ownerDb().query('UPDATE candidates SET region_id = $2 WHERE id = $1', [cands[0], er])).rejects.toThrow(/cannot change once voting has started/);
    await admin.patch(`/api/campaigns/${c.id}/candidates/${cands[0]}`).field('name', 'Renamed').expect(200);   // other edits still follow the old rules
  });
});

describe('audit and the start seal', () => {
  it('rule changes are audited with before and after (region by name)', async () => {
    const { e, admin } = await members({ min: 1, max: 4, rule: { n: 2, region: KH } });
    await admin.patch(`/api/campaigns/${e.id}/positions/${e.positions[0].id}`).send({ region_rule: { min_outside: 1, region_id: e.regions[ER] } }).expect(200);
    await admin.patch(`/api/campaigns/${e.id}/positions/${e.positions[0].id}`).send({ region_rule: null }).expect(200);
    const a = (await audits(e.id, 'position.rule_set')).map((r) => r.details);
    expect(a).toHaveLength(3);
    expect(a[0]).toMatchObject({ title: 'Additional Members', from: { min_picks: 4, max_picks: 4, region_rule: null }, to: { min_picks: 1, max_picks: 4, region_rule: { min_outside: 2, region: KH } } });
    expect(a[1]).toMatchObject({ from: { region_rule: { min_outside: 2, region: KH } }, to: { region_rule: { min_outside: 1, region: ER } } });
    expect(a[2]).toMatchObject({ from: { region_rule: { min_outside: 1, region: ER } }, to: { region_rule: null } });
  });
  it('an unrelated position edit writes no rule entry', async () => {
    const { e, admin } = await members({ min: 1, max: 4 });
    await admin.patch(`/api/campaigns/${e.id}/positions/${e.positions[0].id}`).send({ description: 'New text' }).expect(200);
    expect(await audits(e.id, 'position.rule_set')).toHaveLength(1);
  });
  it('the start seal contains the rules in force', async () => {
    const { e } = await members({ min: 1, max: 4, rule: { n: 2, region: KH }, start: true });
    const d = (await audits(e.id, 'campaign.start'))[0].details;
    expect(d.position_rules).toEqual([{ position_id: e.positions[0].id, title: 'Additional Members', winners: 4, min_picks: 1, max_picks: 4,
      region_rule: { min_outside: 2, region: KH, text: 'At least 2 picks from outside Khomas' } }]);
  });
  it('the rules cannot change once voting has started (API and database)', async () => {
    const { e, admin } = await members({ rule: { n: 2, region: KH }, start: true });
    await admin.patch(`/api/campaigns/${e.id}/positions/${e.positions[0].id}`).send({ min_picks: 1 }).expect(409);
    await expect(ownerDb().query('UPDATE positions SET max_picks = 3 WHERE id = $1', [e.positions[0].id])).rejects.toThrow(/locked/);
  });
});

describe('nominations show the rule to candidates', () => {
  it('the nomination page carries the generated rule sentence next to the eligibility text', async () => {
    const { e, admin } = await members({ rule: { n: 2, region: KH } });
    const inv = (await admin.post(`/api/campaigns/${e.id}/positions/${e.positions[0].id}/invite`).expect(201)).body.invite_url as string;
    const token = inv.split('/n/')[1];
    const p = (await (await login(app, S1)).get(`/api/nominate/${token}`).expect(200)).body.position;
    expect(p.regionRuleText).toBe('At least 2 picks from outside Khomas');
  });
});
