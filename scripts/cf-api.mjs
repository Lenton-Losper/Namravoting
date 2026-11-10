// Tiny Cloudflare API helper for the demo setup. Reads CLOUDFLARE_* from .env; never prints the token.
// Usage: node scripts/cf-api.mjs <METHOD> <path-after-/accounts/ID> [json-body-file]
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch {}
export async function cf(method, apiPath, body) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${apiPath.replace('{acct}', process.env.CLOUDFLARE_ACCOUNT_ID)}`, {
    method, headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [method, p, file] = process.argv.slice(2);
  const out = await cf(method, p, file ? JSON.parse(readFileSync(file, 'utf8')) : undefined);
  console.log(JSON.stringify(out, null, 1));
}
