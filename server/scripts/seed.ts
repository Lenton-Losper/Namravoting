import crypto from 'node:crypto';
import pg from 'pg';
import sharp from 'sharp';
import { loadDotEnv } from '../src/env.js';
import { DEV_USERS } from '../src/auth/devUsers.js';

loadDotEnv();
const url = process.env.MIGRATE_DATABASE_URL;
if (!url) { console.error('MIGRATE_DATABASE_URL is required (see .env.example)'); process.exit(1); }
if (process.env.NODE_ENV === 'production') { console.error('Refusing to seed in production'); process.exit(1); }
const { getConfig } = await import('../src/config.js');
const { savePhoto } = await import('../src/services/images.js');
getConfig();

/** Locally generated placeholder portrait (no external images). */
async function placeholder(initials: string, hue: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
    <rect width="400" height="400" fill="${hue}"/>
    <circle cx="200" cy="155" r="70" fill="rgba(255,255,255,.85)"/>
    <ellipse cx="200" cy="340" rx="120" ry="95" fill="rgba(255,255,255,.85)"/>
    <text x="200" y="385" font-size="28" text-anchor="middle" fill="rgba(0,0,0,.45)" font-family="sans-serif">${initials}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  for (const u of DEV_USERS) {
    await client.query(
      `INSERT INTO users (entra_oid, email, display_name) VALUES ($1,$2,$3)
       ON CONFLICT (entra_oid) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name`,
      [u.oid, u.email, u.displayName]);
  }
  const admin = DEV_USERS[0];
  const title = 'Election of the Commissioner (sample)';
  const exists = await client.query('SELECT 1 FROM campaigns WHERE created_by = $1 AND title = $2', [admin.oid, title]);
  if (exists.rowCount) {
    console.log('Sample campaign already present; skipping.');
  } else {
    const camp = await client.query(
      `INSERT INTO campaigns (share_token, created_by, title, description) VALUES ($1,$2,$3,$4) RETURNING id`,
      [crypto.randomBytes(24).toString('base64url'), admin.oid, title, 'Sample draft campaign created by the seed script.']);
    const cands = [
      ['Ndapewa Shikongo', 'Twenty years in customs and excise; focus on service delivery.', 'NS', '#2b6cb0'],
      ['Tobias Amupanda', 'Former head of domestic taxes; champion of digital filing.', 'TA', '#2f855a'],
      ['Ruth Kandjii', 'Led the large-taxpayer unit; focus on staff development.', 'RK', '#b7791f'],
    ];
    let i = 1;
    for (const [name, bio, ini, hue] of cands) {
      const file = await savePhoto(await placeholder(ini, hue));
      await client.query('INSERT INTO candidates (campaign_id, name, bio, photo_path, sort_order) VALUES ($1,$2,$3,$4,$5)', [camp.rows[0].id, name, bio, file, i++]);
    }
    console.log('Created sample draft campaign with 3 candidates.');
  }
  console.log(`Seeded ${DEV_USERS.length} users (2 admins, 5 staff).`);
} finally {
  await client.end();
}
