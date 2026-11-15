import pg from 'pg';
import { migrate } from '../src/migrate.js';
import { TEST_APP_PASSWORD, TEST_OWNER_URL, pgc } from './testDb.js';


/** Rebuilds the test database schema from the real migrations (as the owner role). */
export default async function setup(): Promise<void> {
  const c = new pg.Client(pgc(TEST_OWNER_URL));
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await migrate(TEST_OWNER_URL, TEST_APP_PASSWORD, () => undefined);
}
