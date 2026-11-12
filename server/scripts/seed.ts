import pg from 'pg';
import { dbClientConfig } from '../src/db.js';
import { loadDotEnv } from '../src/env.js';

loadDotEnv();
const url = process.env.MIGRATE_DATABASE_URL;
if (!url) { console.error('MIGRATE_DATABASE_URL is required (see .env.example)'); process.exit(1); }
if (process.env.NODE_ENV === 'production') { console.error('Refusing to seed in production'); process.exit(1); }
const { getConfig } = await import('../src/config.js');
const { seedDevData } = await import('./seedLib.js');
getConfig();

const client = new pg.Client(dbClientConfig(url));
await client.connect();
try { await seedDevData(client, { openCampaign: false }); } finally { await client.end(); }
