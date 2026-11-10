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

const CANDIDATES: [string, string, string, string][] = [
  ['Ndapewa Shikongo', 'Twenty years in customs and excise; focus on service delivery.', 'NS', '#2b6cb0'],
  ['Tobias Amupanda', 'Former head of domestic taxes; champion of digital filing.', 'TA', '#2f855a'],
  ['Ruth Kandjii', 'Led the large-taxpayer unit; focus on staff development.', 'RK', '#b7791f'],
];

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
    let i = 1;
    for (const [name, bio, ini, hue] of CANDIDATES) {
      const file = await savePhoto(await placeholder(ini, hue));
      await client.query('INSERT INTO candidates (campaign_id, name, bio, photo_path, sort_order) VALUES ($1,$2,$3,$4,$5)', [camp.rows[0].id, name, bio, file, i++]);
    }
    if (status === 'open') {
      await client.query("UPDATE campaigns SET status = 'open' WHERE id = $1", [camp.rows[0].id]);   // owner role: the lock trigger only guards candidates
      await client.query("INSERT INTO audit_log (actor_oid, action, campaign_id, details) VALUES ($1, 'campaign.start', $2, $3)", [admin.oid, camp.rows[0].id, JSON.stringify({ candidates: CANDIDATES.length, seeded: true })]);
    }
    console.log(`Created ${status} campaign "${title}" with ${CANDIDATES.length} candidates.`);
  };
  await make('Election of the Commissioner (sample)', 'Sample draft campaign created by the seed script.', 'draft');
  if (opts.openCampaign) await make('Staff Council Election (demo)', 'Open demo vote for Umoja members. Fake data only.', 'open');
  console.log(`Seeded ${DEV_USERS.length} users (2 admins, 5 staff).`);
}
