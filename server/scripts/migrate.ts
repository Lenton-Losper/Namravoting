import { migrate } from '../src/migrate.js';
import { loadDotEnv } from '../src/env.js';

loadDotEnv();
const url = process.env.MIGRATE_DATABASE_URL;
const pw = process.env.APP_DB_PASSWORD;
if (!url || !pw) { console.error('MIGRATE_DATABASE_URL and APP_DB_PASSWORD are required (see .env.example)'); process.exit(1); }
await migrate(url, pw);
console.log('migrations up to date');
