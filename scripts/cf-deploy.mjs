// Deploys the demo Worker + Container. Secrets come from the repo-root .env and are sent with `wrangler secret bulk`
// (never written into wrangler.jsonc, never printed). Usage: node scripts/cf-deploy.mjs [--secrets-only]
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');
process.loadEnvFile(envPath);
const need = [...(process.env.WRANGLER_OAUTH === '1' ? [] : ['CLOUDFLARE_API_TOKEN']), 'CLOUDFLARE_ACCOUNT_ID', 'DEMO_DATABASE_URL', 'CF_ACCESS_AUD', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', 'DEMO_USERS', 'ENTRA_CLIENT_SECRET'];
for (const k of need) if (!process.env[k]) { console.error(`${k} is missing from .env`); process.exit(1); }
if (!process.env.DEMO_SESSION_SECRET) {   // generated once: 48 random bytes
  process.env.DEMO_SESSION_SECRET = crypto.randomBytes(48).toString('base64url');
  appendFileSync(envPath, `DEMO_SESSION_SECRET=${process.env.DEMO_SESSION_SECRET}\n`);
}
const wr = (args) => spawnSync(process.execPath, [path.join(root, 'scripts/wrangler.mjs'), ...args], { cwd: root, stdio: 'inherit', env: process.env }).status;

if (!process.argv.includes('--secrets-only')) {
  const code = wr(['deploy']);
  if (code !== 0) process.exit(code ?? 1);
}
const dir = mkdtempSync(path.join(os.tmpdir(), 'cfsecrets-'));
const file = path.join(dir, 'secrets.json');
try {
  writeFileSync(file, JSON.stringify({
    DATABASE_URL: process.env.DEMO_DATABASE_URL, SESSION_SECRET: process.env.DEMO_SESSION_SECRET, CF_ACCESS_AUD: process.env.CF_ACCESS_AUD,
    DEMO_USERS: process.env.DEMO_USERS, ENTRA_CLIENT_SECRET: process.env.ENTRA_CLIENT_SECRET,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY, R2_ENDPOINT: process.env.R2_ENDPOINT,
  }), { mode: 0o600 });
  const code = wr(['secret', 'bulk', file]);
  if (code !== 0) process.exit(code ?? 1);
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('Secrets set.');
