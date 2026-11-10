// Sets up the Cloudflare DEMO database (Neon): migrations (as the owner role) + fake demo data.
// Usage: npm run demo:db -w server          (reads DEMO_OWNER_DATABASE_URL, DEMO_DATABASE_URL, DEMO_APP_DB_PASSWORD from .env)
// Photos for the seeded candidates go to R2 (STORAGE=r2). Never touches the real Umoja list or anything under data/.
import pg from 'pg';
import { loadDotEnv } from '../src/env.js';

loadDotEnv();
const owner = process.env.DEMO_OWNER_DATABASE_URL;
const app = process.env.DEMO_DATABASE_URL;
const appPassword = process.env.DEMO_APP_DB_PASSWORD;
if (!owner || !app || !appPassword) { console.error('DEMO_OWNER_DATABASE_URL, DEMO_DATABASE_URL and DEMO_APP_DB_PASSWORD are required in .env'); process.exit(1); }
for (const u of [owner, app]) if (!/sslmode=require/.test(u)) { console.error('Demo database URLs must use sslmode=require'); process.exit(1); }

// The seed uses the app config (storage backend). Point it at the demo app role + R2.
process.env.NODE_ENV = 'development';
process.env.STORAGE = 'r2';
process.env.DATABASE_URL = app;
process.env.SESSION_SECRET ??= 'demo-setup-only-secret-demo-setup-only-secret';
const { migrate } = await import('../src/migrate.js');
const { seedDevData } = await import('./seedLib.js');

await migrate(owner, appPassword);
const client = new pg.Client({ connectionString: owner });
await client.connect();
try { await seedDevData(client, { openCampaign: true }); } finally { await client.end(); }
console.log('Demo database ready.');
