// Production migration runner (compiled to dist/migrateCli.js; needs no dev tooling):
//   node server/dist/migrateCli.js
// Reads MIGRATE_DATABASE_URL (the owner role) and APP_DB_PASSWORD (the password of the restricted namra_app role) from the environment.
import { migrate } from './migrate.js';
import { loadDotEnv } from './env.js';

loadDotEnv();
const url = process.env.MIGRATE_DATABASE_URL;
const pw = process.env.APP_DB_PASSWORD;
if (!url || !pw) { console.error('MIGRATE_DATABASE_URL and APP_DB_PASSWORD are required (see .env.example)'); process.exit(1); }
try {
  await migrate(url, pw);
  console.log('migrations up to date');
} catch (e) {
  console.error(`MIGRATION ERROR: ${(e as Error).message}`);
  process.exit(1);
}
