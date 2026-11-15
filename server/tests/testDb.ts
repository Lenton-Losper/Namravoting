import fs from 'node:fs';
import path from 'node:path';
import type pg from 'pg';
import { dbClientConfig } from '../src/db.js';

/**
 * Where the server tests run. The globalSetup DROPs the public schema, so this is deliberately strict:
 *  - with no .env.test the tests use the local docker database (localhost:5433);
 *  - with a repo-root .env.test they use TEST_OWNER_DATABASE_URL (owner role, builds the schema) and
 *    TEST_APP_DATABASE_URL (the app role, same database);
 *  - the real .env is never read here, and the tests refuse to run if a test URL points at the same host and
 *    database as anything in it.
 */
const root = path.resolve(import.meta.dirname, '../..');

function parseEnvFile(file: string): Record<string, string> {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || m[1].startsWith('#')) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

const target = (url: string) => { try { const u = new URL(url); return `${u.hostname.toLowerCase()}${u.pathname}`; } catch { return url; } };

const LOCAL_OWNER = 'postgres://namra_owner:namra_owner_dev@localhost:5433/namra_test';
const LOCAL_APP = 'postgres://namra_app:namra_app_dev@localhost:5433/namra_test';

function resolveUrls(): { owner: string; app: string; remote: boolean } {
  const f = parseEnvFile(path.join(root, '.env.test'));
  const owner = f.TEST_OWNER_DATABASE_URL, app = f.TEST_APP_DATABASE_URL;
  if (!owner && !app) return { owner: LOCAL_OWNER, app: LOCAL_APP, remote: false };
  if (!owner || !app) throw new Error('.env.test must set both TEST_OWNER_DATABASE_URL and TEST_APP_DATABASE_URL');
  if (target(owner) !== target(app)) throw new Error('.env.test: the owner and app URLs must point at the same database');
  const real = parseEnvFile(path.join(root, '.env'));
  for (const [k, v] of Object.entries(real)) {
    if (/^postgres(ql)?:\/\//.test(v) && target(v) === target(owner)) {
      throw new Error(`.env.test points at the same database as ${k} in .env. Refusing to run: the tests drop the schema. Use a separate Neon branch.`);
    }
  }
  return { owner, app, remote: true };
}

const urls = resolveUrls();
export const TEST_OWNER_URL = urls.owner;
export const TEST_APP_URL = urls.app;
/** The app role's password, as migrate() needs it to (re)set the role. */
export const TEST_APP_PASSWORD = decodeURIComponent(new URL(urls.app).password);
export const TEST_DB_IS_REMOTE = urls.remote;

/** Connection settings for a test URL: plain for the local database, verified TLS for a remote one (Neon). */
export const pgc = (url: string): pg.ClientConfig => dbClientConfig(url);
