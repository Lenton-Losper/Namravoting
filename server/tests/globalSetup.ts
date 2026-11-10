import pg from 'pg';
import { migrate } from '../src/migrate.js';

const TEST_OWNER_URL = 'postgres://namra_owner:namra_owner_dev@localhost:5433/namra_test';

/** Rebuilds the test database schema from the real migrations (as the owner role). */
export default async function setup(): Promise<void> {
  const c = new pg.Client({ connectionString: TEST_OWNER_URL });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(TEST_OWNER_URL, 'namra_app_dev', () => undefined);
}
