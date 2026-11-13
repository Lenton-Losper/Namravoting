import crypto from 'node:crypto';
import type pg from 'pg';
import sharp from 'sharp';
import { DEV_USERS, DEV_UMOJA_MEMBERS } from '../src/auth/devUsers.js';

/** Locally generated placeholder portrait (no external images). */
async function placeholder(initials: string, hue: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
    <rect width="400" height="400" fill="${hue}"/>
    <circle cx="200" cy="155" r="70" fill="rgba(255,255,255,.85)"/>
    <ellipse cx="200" cy="340" rx="120" ry="95" fill="rgba(255,255,255,.85)"/>
    <text x="200" y="385" font-size="28" text-anchor="middle" fill="rgba(0,0,0,.45)" font-family="sans-serif">${initials}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// name, bio, initials, colour, position (index into POSITIONS), region
const CANDIDATES: [string, string, string, string, number, string][] = [
  ['Ndapewa Shikongo', 'Twenty years in customs and excise; focus on service delivery.', 'NS', '#2b6cb0', 0, 'Khomas'],
  ['Tobias Amupanda', 'Former head of domestic taxes; champion of digital filing.', 'TA', '#2f855a', 0, 'Oshana'],
  ['Ruth Kandjii', 'Led the large-taxpayer unit; focus on staff development.', 'RK', '#b7791f', 0, 'Erongo'],
  ['Johannes Haufiku', 'Chief accountant for the Walvis Bay office; clear, plain budgets.', 'JH', '#805ad5', 1, 'Erongo'],
  ['Selma Nakale', 'Audit and risk specialist; wants quarterly reports to members.', 'SN', '#c05621', 1, 'Ohangwena'],
  ['Petrus Kavetuna', 'Regional collections lead; knows what each office needs.', 'PK', '#2c7a7b', 1, 'Zambezi'],
];
const POSITIONS = ['Press Secretary', 'Finance Officer'];

/**
 * Dev/demo seed (owner connection). Fake data only. Needs src/config to be loadable (SESSION_SECRET, DATABASE_URL set)
 * because photos go through the configured storage backend (disk, or R2 when STORAGE=r2).
 */
export async function seedDevData(client: pg.Client, opts: { openCampaign: boolean }): Promise<void> {
  const { savePhoto } = await import('../src/services/images.js');
  for (const u of DEV_USERS) {
    await client.query(
      `INSERT INTO users (entra_oid, email, display_name, employee_code) VALUES ($1,$2,$3,$4)
       ON CONFLICT (entra_oid) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, employee_code = EXCLUDED.employee_code`,
      [u.oid, u.email, u.displayName, u.employeeCode]);
  }
  // Fake Umoja list ONLY when none has been imported (never overwrites a real import).
  const have = (await client.query('SELECT count(*)::int AS n FROM umoja_members')).rows[0].n as number;
  if (have === 0) {
    await client.query('INSERT INTO umoja_members (employee_code, active) SELECT * FROM unnest($1::text[], $2::boolean[])',
      [DEV_UMOJA_MEMBERS.map((m) => m.code), DEV_UMOJA_MEMBERS.map((m) => m.active)]);
    console.log(`Seeded ${DEV_UMOJA_MEMBERS.length} fake Umoja members (TST codes).`);
  } else console.log('umoja_members already populated; leaving it alone.');

  const admin = DEV_USERS[0];
  const make = async (title: string, description: string, status: 'draft' | 'open') => {
    const exists = await client.query('SELECT 1 FROM campaigns WHERE created_by = $1 AND title = $2', [admin.oid, title]);
    if (exists.rowCount) { console.log(`Campaign "${title}" already present; skipping.`); return; }
    const camp = await client.query(
      'INSERT INTO campaigns (share_token, created_by, title, description) VALUES ($1,$2,$3,$4) RETURNING id',
      [crypto.randomBytes(24).toString('base64url'), admin.oid, title, description]);
    // The 14 regions of Namibia, and two positions (each with three approved candidates).
    const { DEFAULT_REGIONS } = await import('../src/services/positions.js');
    await client.query('INSERT INTO regions (campaign_id, name, sort_order) SELECT $1, n, o FROM unnest($2::text[]) WITH ORDINALITY AS t(n, o)', [camp.rows[0].id, [...DEFAULT_REGIONS]]);
    const positionIds: string[] = [];
    for (const [pi, title] of POSITIONS.entries()) {
      positionIds.push((await client.query('INSERT INTO positions (campaign_id, title, sort_order) VALUES ($1,$2,$3) RETURNING id', [camp.rows[0].id, title, pi + 1])).rows[0].id);
    }
    let i = 1;
    for (const [name, bio, ini, hue, pi, region] of CANDIDATES) {
      const file = await savePhoto(await placeholder(ini, hue));
      await client.query(
        'INSERT INTO candidates (campaign_id, position_id, region_id, name, bio, photo_path, sort_order) VALUES ($1,$2,(SELECT id FROM regions WHERE campaign_id = $1 AND name = $3),$4,$5,$6,$7)',
        [camp.rows[0].id, positionIds[pi], region, name, bio, file, i++]);
    }
    if (status === 'open') {
      await client.query("UPDATE campaigns SET status = 'open' WHERE id = $1", [camp.rows[0].id]);   // owner role: the lock trigger only guards candidates
      // What /start does: one counter per candidate, and the frozen voter list (new campaigns default to Umoja-only).
      await client.query("INSERT INTO tallies (campaign_id, position_id, candidate_id, votes) SELECT campaign_id, position_id, id, 0 FROM candidates WHERE campaign_id = $1 AND status = 'approved'", [camp.rows[0].id]);
      await client.query('INSERT INTO campaign_voters (campaign_id, member_code, entra_oid, active) SELECT $1, employee_code, entra_oid, active FROM umoja_members', [camp.rows[0].id]);
      await client.query("INSERT INTO audit_log (actor_oid, action, campaign_id, details) VALUES ($1, 'campaign.start', $2, $3)", [admin.oid, camp.rows[0].id, JSON.stringify({ candidates: CANDIDATES.length, positions: POSITIONS.length, seeded: true })]);
    }
    console.log(`Created ${status} campaign "${title}" with ${POSITIONS.length} positions and ${CANDIDATES.length} candidates.`);
  };
  await make('Election of the Commissioner (sample)', 'Sample draft campaign created by the seed script.', 'draft');
  if (opts.openCampaign) await make('Staff Council Election (demo)', 'Open demo vote for Umoja members. Fake data only.', 'open');
  console.log(`Seeded ${DEV_USERS.length} users (2 admins, 5 staff).`);
}
