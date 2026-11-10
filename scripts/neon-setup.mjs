// Creates the Neon project for the demo (idempotent) and writes DEMO_OWNER_DATABASE_URL / DEMO_DATABASE_URL /
// DEMO_APP_DB_PASSWORD to the repo-root .env. Never prints credentials.
import { appendFileSync, readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
try { process.loadEnvFile(envPath); } catch {}
const key = process.env.NEON_API_KEY;
if (!key) { console.error('NEON_API_KEY missing from .env'); process.exit(1); }
const api = async (method, p, body) => {
  const r = await fetch(`https://console.neon.tech/api/v2${p}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} -> HTTP ${r.status}: ${j.message ?? JSON.stringify(j).slice(0, 300)}`);
  return j;
};
const hasEnv = (k) => new RegExp(`^${k}=.+`, 'm').test(readFileSync(envPath, 'utf8'));

const list = await api('GET', '/projects?limit=100');
let project = list.projects.find((p) => p.name === 'namra-voting-demo');
let ownerUri;
if (project) {
  console.log(`Project namra-voting-demo already exists (${project.id}, ${project.region_id}).`);
} else {
  const created = await api('POST', '/projects', { project: { name: 'namra-voting-demo', region_id: 'aws-eu-central-1', pg_version: 16, branch: { name: 'main', role_name: 'namra_owner', database_name: 'namra' } } });
  project = created.project;
  ownerUri = created.connection_uris?.[0]?.connection_uri;
  console.log(`Created project ${project.id} in ${project.region_id}, Postgres ${project.pg_version}.`);
}
if (!hasEnv('DEMO_OWNER_DATABASE_URL')) {
  if (!ownerUri) {
    const q = new URLSearchParams({ database_name: 'namra', role_name: 'namra_owner', pooled: 'false' });
    ownerUri = (await api('GET', `/projects/${project.id}/connection_uri?${q}`)).uri;
  }
  const u = new URL(ownerUri);
  if (u.hostname.includes('-pooler')) u.hostname = u.hostname.replace('-pooler', '');   // direct endpoint: migrations + SERIALIZABLE
  u.search = 'sslmode=require';
  appendFileSync(envPath, `\n# Neon project ${project.id} (${project.region_id})\nNEON_PROJECT_ID=${project.id}\nDEMO_OWNER_DATABASE_URL=${u.toString()}\n`);
  console.log(`Saved DEMO_OWNER_DATABASE_URL (host ${u.hostname}).`);
}
if (!hasEnv('DEMO_DATABASE_URL')) {
  const pw = crypto.randomBytes(24).toString('base64url');
  const o = new URL(readFileSync(envPath, 'utf8').match(/^DEMO_OWNER_DATABASE_URL=(.+)$/m)[1].trim());
  const a = new URL(o.toString()); a.username = 'namra_app'; a.password = pw;
  appendFileSync(envPath, `DEMO_APP_DB_PASSWORD=${pw}\nDEMO_DATABASE_URL=${a.toString()}\n`);
  console.log('Generated a random password for the namra_app role and saved DEMO_DATABASE_URL (host ' + a.hostname + ').');
}
