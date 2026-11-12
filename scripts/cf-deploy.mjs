// Deploys the demo Worker + Container. Secrets come from the repo-root .env and are sent with `wrangler secret bulk`
// (never written into wrangler.jsonc, never printed). Usage: node scripts/cf-deploy.mjs [--secrets-only]
//
// SEC-23: only the secrets the ACTIVE auth mode (from worker/wrangler.jsonc) needs are required and sent; a config that would run
// the dev identity picker, or not run as production, is refused; and nothing is ever generated silently: a missing session secret is
// an error with the command to make one (a new value signs everyone out, so a human must choose to do it).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseJsonc, planDeploy } from './deploy-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* no .env (GitHub Actions): the secrets are in the real environment */ }
const wrangler = parseJsonc(readFileSync(path.join(root, 'worker/wrangler.jsonc'), 'utf8'));
const plan = planDeploy(process.env, wrangler.vars);
if (plan.problems.length) {
  console.error('Not deploying:\n - ' + plan.problems.join('\n - '));
  if (plan.problems.some((p) => p.startsWith('DEMO_SESSION_SECRET is missing'))) {
    console.error('\nMake a session secret yourself (a NEW value signs every user out, which is why this script never does it for you):\n  node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64url\'))"\nand add it to .env as DEMO_SESSION_SECRET=...');
  }
  process.exit(1);
}
console.log(`Deploying in AUTH_MODE=${plan.mode}. Secrets that will be set: ${plan.names.join(', ')}`);

const wr = (args) => spawnSync(process.execPath, [path.join(root, 'scripts/wrangler.mjs'), ...args], { cwd: root, stdio: 'inherit', env: process.env }).status;

if (!process.argv.includes('--secrets-only')) {
  const code = wr(['deploy']);
  if (code !== 0) process.exit(code ?? 1);
}
const dir = mkdtempSync(path.join(os.tmpdir(), 'cfsecrets-'));
const file = path.join(dir, 'secrets.json');
try {
  writeFileSync(file, JSON.stringify(plan.secrets), { mode: 0o600 });
  const code = wr(['secret', 'bulk', file]);
  if (code !== 0) process.exit(code ?? 1);
} finally { rmSync(dir, { recursive: true, force: true }); }
console.log('Secrets set.');
