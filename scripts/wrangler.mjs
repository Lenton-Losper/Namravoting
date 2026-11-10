// Runs wrangler with the Cloudflare credentials from the repo-root .env (never printed, never committed).
// Usage: node scripts/wrangler.mjs <wrangler args...>   (run from the repo root; cwd for wrangler is worker/)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* rely on the real environment */ }
for (const k of ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN']) {
  if (!process.env[k]) { console.error(`${k} is missing from .env`); process.exit(1); }
}
const bin = path.join(root, 'worker/node_modules/wrangler/bin/wrangler.js');
const r = spawnSync(process.execPath, [bin, ...process.argv.slice(2)], { cwd: path.join(root, 'worker'), stdio: 'inherit', env: process.env });
process.exit(r.status ?? 1);
