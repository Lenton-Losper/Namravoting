// Migration 019: an old single-question campaign becomes a campaign with ONE default position, and nothing about it changes.
import crypto from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/migrate.js';
import { TEST_OWNER_URL } from '../helpers.js';

const OLD_DB = 'namra_migration_019';
const adminUrl = TEST_OWNER_URL.replace(/\/namra_test$/, '/postgres');
const oldUrl = TEST_OWNER_URL.replace(/\/namra_test$/, `/${OLD_DB}`);
const BEFORE = '018_quorum_and_publication.sql';

let db: pg.Client;
const U = { admin: crypto.randomUUID(), v1: crypto.randomUUID(), v2: crypto.randomUUID() };
const ids = { open: crypto.randomUUID(), closed: crypto.randomUUID(), draft: crypto.randomUUID() };
const cand: Record<string, string[]> = { open: [], closed: [], draft: [] };

beforeAll(async () => {
  const a = new pg.Client({ connectionString: adminUrl });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${OLD_DB}`);
  await a.query(`CREATE DATABASE ${OLD_DB}`);
  await a.end();

  await migrate(oldUrl, 'namra_app_dev', () => undefined, BEFORE);   // the database as it was before positions existed
  db = new pg.Client({ connectionString: oldUrl });
  await db.connect();

  for (const [i, u] of [U.admin, U.v1, U.v2].entries()) await db.query('INSERT INTO users (entra_oid, email, display_name) VALUES ($1, $2, $3)', [u, `old${i}@x.test`, `Old ${i}`]);
  const tok = () => crypto.randomBytes(24).toString('base64url');
  for (const [key, title] of [['open', 'Old open vote'], ['closed', 'Old closed vote'], ['draft', 'Old draft vote']] as const) {
    await db.query("INSERT INTO campaigns (id, share_token, created_by, title, eligibility) VALUES ($1, $2, $3, $4, 'all')", [ids[key], tok(), U.admin, title]);
    for (const n of ['Ann', 'Ben']) cand[key].push((await db.query('INSERT INTO candidates (campaign_id, name, sort_order) VALUES ($1, $2, 1) RETURNING id', [ids[key], n])).rows[0].id);
  }
  // an abstain line on the open one, withdrawn candidate on none; then start the open and the closed ones the way the old code did
  await db.query("INSERT INTO candidates (campaign_id, name, sort_order, is_abstain) VALUES ($1, 'Abstain (none of the above)', 2000000000, true)", [ids.open]);
  for (const key of ['open', 'closed'] as const) {
    await db.query("UPDATE campaigns SET status = 'open' WHERE id = $1", [ids[key]]);
    await db.query('INSERT INTO tallies (campaign_id, candidate_id, votes) SELECT campaign_id, id, 0 FROM candidates WHERE campaign_id = $1', [ids[key]]);
  }
  // two votes in the open campaign (receipt + counter), one in the closed one, which is then closed
  await db.query("INSERT INTO vote_receipts (campaign_id, voter_oid, member_key) VALUES ($1, $2, $3), ($1, $4, $5)", [ids.open, U.v1, `oid:${U.v1}`, U.v2, `oid:${U.v2}`]);
  await db.query('UPDATE tallies SET votes = 2 WHERE campaign_id = $1 AND candidate_id = $2', [ids.open, cand.open[0]]);
  await db.query("INSERT INTO vote_receipts (campaign_id, voter_oid, member_key) VALUES ($1, $2, $3)", [ids.closed, U.v1, `oid:${U.v1}`]);
  await db.query('UPDATE tallies SET votes = 1 WHERE campaign_id = $1 AND candidate_id = $2', [ids.closed, cand.closed[1]]);
  await db.query("UPDATE campaigns SET status = 'closed' WHERE id = $1", [ids.closed]);
  await db.query("INSERT INTO audit_log (actor_oid, action, campaign_id, details) VALUES ($1, 'campaign.close', $2, '{\"old\":true}')", [U.admin, ids.closed]);

  await migrate(oldUrl, 'namra_app_dev', () => undefined);          // the new migration, on top of real data
});

afterAll(async () => {
  await db?.end();
  const a = new pg.Client({ connectionString: adminUrl });
  await a.connect();
  await a.query(`DROP DATABASE IF EXISTS ${OLD_DB}`);
  await a.end();
});

describe('migration 019 on a database that already holds campaigns', () => {
  it('gives every campaign (draft, open, closed) exactly one default position named after it', async () => {
    const { rows } = await db.query('SELECT p.campaign_id, p.title, p.seats, p.status, p.rules, p.sort_order, c.title AS campaign FROM positions p JOIN campaigns c ON c.id = p.campaign_id ORDER BY c.title');
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.title).toBe(r.campaign);
      expect(r.seats).toBe(1);
      expect(r.status).toBe('open');
      expect(r.rules).toEqual({});
    }
  });

  it('moves every candidate, counter and receipt into that position, unchanged', async () => {
    for (const key of ['open', 'closed', 'draft'] as const) {
      const pos = (await db.query('SELECT id FROM positions WHERE campaign_id = $1', [ids[key]])).rows[0].id;
      expect((await db.query('SELECT count(*)::int AS n FROM candidates WHERE campaign_id = $1 AND position_id <> $2', [ids[key], pos])).rows[0].n).toBe(0);
      expect((await db.query('SELECT count(*)::int AS n FROM tallies WHERE campaign_id = $1 AND position_id <> $2', [ids[key], pos])).rows[0].n).toBe(0);
      expect((await db.query('SELECT count(*)::int AS n FROM vote_receipts WHERE campaign_id = $1 AND position_id <> $2', [ids[key], pos])).rows[0].n).toBe(0);
    }
    // the books still balance: receipts = sum of the counters, per campaign
    expect((await db.query('SELECT coalesce(sum(votes), 0)::int AS n FROM tallies WHERE campaign_id = $1', [ids.open])).rows[0].n).toBe(2);
    expect((await db.query('SELECT count(*)::int AS n FROM vote_receipts WHERE campaign_id = $1', [ids.open])).rows[0].n).toBe(2);
    expect((await db.query('SELECT votes FROM tallies WHERE candidate_id = $1', [cand.closed[1]])).rows[0].votes).toBe(1);
    // every old candidate counts as approved (it was on the ballot)
    expect((await db.query("SELECT count(*)::int AS n FROM candidates WHERE status <> 'approved'")).rows[0].n).toBe(0);
  });

  it('seeds the 14 regions of Namibia for every campaign', async () => {
    const { rows } = await db.query('SELECT name FROM regions WHERE campaign_id = $1 ORDER BY sort_order', [ids.draft]);
    expect(rows.map((r) => r.name)).toEqual(['Erongo', 'Hardap', '//Kharas', 'Kavango East', 'Kavango West', 'Khomas', 'Kunene', 'Ohangwena', 'Omaheke', 'Omusati', 'Oshana', 'Oshikoto', 'Otjozondjupa', 'Zambezi']);
  });

  it('keeps the old audit entries as they were (the hash chain still verifies)', async () => {
    expect((await db.query('SELECT audit_chain_verify() AS r')).rows[0].r.ok).toBe(true);
    expect((await db.query("SELECT details FROM audit_log WHERE action = 'campaign.close'")).rows[0].details).toEqual({ old: true });
  });

  it('makes the rules: one vote per member per position, the abstain line per position, and receipts that name a position', async () => {
    const pos = (await db.query('SELECT id FROM positions WHERE campaign_id = $1', [ids.open])).rows[0].id;
    await expect(db.query('INSERT INTO vote_receipts (campaign_id, position_id, voter_oid, member_key) VALUES ($1, $2, $3, $4)', [ids.open, pos, U.admin, `oid:${U.v1}`])).rejects.toThrow(/vote_receipts_member_unique/);
    await expect(db.query('INSERT INTO candidates (campaign_id, name, is_abstain) VALUES ($1, $2, true)', [ids.draft, 'x'])).rejects.toThrow(/position_id|locked|null/);
    // a second position in a draft is fine, and gets its own abstain line
    const p2 = (await db.query("INSERT INTO positions (campaign_id, title, sort_order) VALUES ($1, 'Second', 2) RETURNING id", [ids.draft])).rows[0].id;
    await db.query("INSERT INTO candidates (campaign_id, position_id, name, is_abstain) VALUES ($1, $2, 'Abstain', true)", [ids.draft, p2]);
  });

  it('the sealed result of the old closed campaign is untouched and its position holds the one vote', async () => {
    const pos = (await db.query('SELECT id FROM positions WHERE campaign_id = $1', [ids.closed])).rows[0].id;
    expect((await db.query('SELECT count(*)::int AS n FROM vote_receipts WHERE position_id = $1', [pos])).rows[0].n).toBe(1);
  });
});
