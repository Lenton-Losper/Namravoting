// Business-logic item 2: an optional "Abstain (none of the above)" line on the ballot.
import ExcelJS from 'exceljs';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { ADMIN_A, S1, S2, S3, TEST_APP_URL, closeOwner, login, ownerDb, resetDb } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterAll(async () => { await closePool(); await closeOwner(); });

type Admin = Awaited<ReturnType<typeof login>>;
async function make(admin: Admin, opts: { abstain?: boolean; n?: number; allow?: boolean; start?: boolean } = {}) {
  const body: Record<string, unknown> = { title: 'Abstain test', eligibility: 'all' };
  if (opts.abstain !== undefined) body.allow_abstain = opts.abstain;
  if (opts.allow) body.allow_edits_after_start = true;
  const c = (await admin.post('/api/campaigns').send(body).expect(201)).body;
  const cands: string[] = [];
  for (let i = 0; i < (opts.n ?? 2); i++) cands.push((await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', `Cand ${i + 1}`).expect(201)).body.id);
  if (opts.start) await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
  return { id: c.id as string, token: c.share_token as string, cands, created: c };
}
const abstainId = async (campaignId: string) => (await ownerDb().query('SELECT id FROM candidates WHERE campaign_id = $1 AND is_abstain', [campaignId])).rows[0]?.id as string | undefined;

describe('the setting', () => {
  it('is off by default: no Abstain line', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { start: true });
    expect(c.created.allow_abstain).toBe(false);
    expect(await abstainId(c.id)).toBeUndefined();
    const ballot = (await (await login(app, S1)).get(`/api/vote/${c.token}`).expect(200)).body;
    expect(ballot.candidates.every((x: { isAbstain: boolean }) => !x.isAbstain)).toBe(true);
  });

  it('when on, the ballot ends with an Abstain line, and the creator\'s candidate list does not show it', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { abstain: true, start: true });
    const ballot = (await (await login(app, S1)).get(`/api/vote/${c.token}`).expect(200)).body;
    expect(ballot.candidates.map((x: { name: string }) => x.name)).toEqual(['Cand 1', 'Cand 2', 'Abstain (none of the above)']);
    expect(ballot.candidates[2].isAbstain).toBe(true);
    const detail = (await admin.get(`/api/campaigns/${c.id}`).expect(200)).body;
    expect(detail.allow_abstain).toBe(true);
    expect(detail.candidates.map((x: { name: string }) => x.name)).toEqual(['Cand 1', 'Cand 2']);
  });

  it('can be switched on and off while a draft, and is locked once the campaign starts', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { allow: true });
    await admin.patch(`/api/campaigns/${c.id}`).send({ allow_abstain: true }).expect(200);
    expect(await abstainId(c.id)).toBeDefined();
    await admin.patch(`/api/campaigns/${c.id}`).send({ allow_abstain: false }).expect(200);
    expect(await abstainId(c.id)).toBeUndefined();
    await admin.patch(`/api/campaigns/${c.id}`).send({ allow_abstain: true }).expect(200);
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const r = await admin.patch(`/api/campaigns/${c.id}`).send({ allow_abstain: false }).expect(409);
    expect(r.body.code).toBe('locked');
    // and the database says no even if the application were wrong
    const app_ = new pg.Pool({ connectionString: TEST_APP_URL, max: 1 });
    await expect(app_.query('UPDATE campaigns SET allow_abstain = false WHERE id = $1', [c.id])).rejects.toThrow(/locked/);
    await app_.end();
  });

  it('the Abstain line is not a candidate: it does not count towards the 2 needed, and cannot be edited or removed', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { abstain: true, n: 1 });
    const r = await admin.post(`/api/campaigns/${c.id}/start`).expect(409);
    expect(r.body.code).toBe('needs_candidates');
    const id = await abstainId(c.id);
    await admin.patch(`/api/campaigns/${c.id}/candidates/${id}`).field('name', 'Renamed').expect(404);
    await admin.del(`/api/campaigns/${c.id}/candidates/${id}`).expect(404);
    expect(await abstainId(c.id)).toBe(id);
  });
});

describe('counting', () => {
  /** Cand 1 gets `a` votes, Cand 2 gets `b`, Abstain gets `x`. */
  async function closedWith(a: number, b: number, x: number) {
    const admin = await login(app, ADMIN_A);
    const c = await make(admin, { abstain: true, start: true });
    const abs = (await abstainId(c.id))!;
    const picks = [...Array(a).fill(c.cands[0]), ...Array(b).fill(c.cands[1]), ...Array(x).fill(abs)];
    const voters = [S1, S2, S3];
    for (let i = 0; i < picks.length; i++) await (await login(app, voters[i])).post(`/api/vote/${c.token}`).send({ candidateId: picks[i] }).expect(201);
    await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
    return { admin, ...c, abs };
  }

  it('an abstention is a vote cast: it counts in turnout and the seal verifies', async () => {
    const c = await closedWith(1, 0, 2);
    const r = (await c.admin.get(`/api/campaigns/${c.id}/results`).expect(200)).body;
    expect(r.turnout.votes).toBe(3);
    expect(r.candidates.find((x: { is_abstain: boolean }) => x.is_abstain).votes).toBe(2);
    const v = (await c.admin.get(`/api/campaigns/${c.id}/verify`).expect(200)).body;
    expect(v).toMatchObject({ chain_ok: true, sealed: true, tallies_match: true, receipts_match: true });
  });

  it('abstain can never win, even with the most votes, and cannot make a tie', async () => {
    const c = await closedWith(1, 0, 2);
    const r = (await c.admin.get(`/api/campaigns/${c.id}/results`).expect(200)).body;
    expect(r.tie).toBeNull();
    const closed = (await c.admin.get('/api/campaigns/summary').expect(200)).body.closed;
    expect(closed[0].winner.name).toBe('Cand 1');                                  // not "Abstain"
    const t = await closedWith(1, 1, 1);
    expect((await t.admin.get(`/api/campaigns/${t.id}/results`)).body.tie.names).toEqual(['Cand 1', 'Cand 2']);
  });

  it('the CSV reports abstentions on their own line, not as a candidate', async () => {
    const c = await closedWith(2, 0, 1);
    const csv = (await c.admin.get(`/api/campaigns/${c.id}/results.csv`).expect(200)).text.split('\r\n');
    expect(csv).toContain('Abstentions (not a candidate),1');
    expect(csv).toContain('Total ballots,3');
    expect(csv.filter((l) => l.startsWith('Abstain (none'))).toHaveLength(0);
  });

  it('Excel and PDF report them separately and rank only candidates', async () => {
    const c = await closedWith(2, 0, 1);
    const bin = (res: import('superagent').Response, cb: (e: Error | null, b: Buffer) => void) => { const k: Buffer[] = []; res.on('data', (d: Buffer) => k.push(d)); res.on('end', () => cb(null, Buffer.concat(k))); };
    const x = await c.admin.get(`/api/campaigns/${c.id}/results.xlsx`).buffer(true).parse(bin).expect(200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.body as never);
    const rows: string[] = []; wb.getWorksheet('Results')!.eachRow((r) => rows.push((r.values as unknown[]).slice(1).join('|')));
    expect(rows).toContain('1|Cand 1|2|0.6666666666666666');
    expect(rows.some((l) => l.startsWith('|Abstentions (not a candidate)|1'))).toBe(true);
    expect(rows.filter((l) => /^\d+\|Abstain/.test(l))).toHaveLength(0);          // never given a rank
    await c.admin.get(`/api/campaigns/${c.id}/results.pdf`).expect(200);
  });
});
