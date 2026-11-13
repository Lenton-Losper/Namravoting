// Restore drill. Proves the database can be brought back and that the copy is trustworthy, WITHOUT touching the live database:
//   1. creates a temporary Neon branch of the live (default) branch, as of now;
//   2. runs `npm run restore:check` against it (migrations, audit chain, receipts = counters, sealed results, sealed-result copies);
//   3. deletes the branch again (even if a check failed).
// The live database is only read (a branch is a copy-on-write fork). Never prints credentials.
//   node scripts/restore-drill.mjs [--keep]      (--keep leaves the branch for inspection; delete it yourself afterwards)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* CI */ }
const key = process.env.NEON_API_KEY;
if (!key) { console.error('NEON_API_KEY is missing (.env)'); process.exit(1); }
const keep = process.argv.includes('--keep');
const api = async (method, p, body) => {
  const r = await fetch(`https://console.neon.tech/api/v2${p}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} -> HTTP ${r.status}: ${j.message ?? JSON.stringify(j).slice(0, 200)}`);
  return j;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const projects = (await api('GET', '/projects?limit=100')).projects;
const project = projects.find((x) => x.id === process.env.NEON_PROJECT_ID) ?? projects.find((x) => x.name === 'namra-voting-demo') ?? projects[0];
if (!project) { console.error('No Neon project found'); process.exit(1); }
const branches = (await api('GET', `/projects/${project.id}/branches`)).branches;
const main = branches.find((b) => b.default) ?? branches[0];
const name = `restore-drill-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
console.log(`Live branch: ${main.name}. Creating the temporary branch ${name} (a fork of it as of now)...`);

const created = await api('POST', `/projects/${project.id}/branches`, { branch: { name, parent_id: main.id }, endpoints: [{ type: 'read_write' }] });
const branchId = created.branch.id;
let failed = false;
try {
  // wait until the branch's compute is ready
  for (let i = 0; i < 40; i++) {
    const eps = (await api('GET', `/projects/${project.id}/branches/${branchId}/endpoints`)).endpoints;
    if (eps.length && eps[0].current_state === 'active' || eps[0]?.current_state === 'idle') break;
    await sleep(3000);
  }
  const q = new URLSearchParams({ branch_id: branchId, database_name: 'namra', role_name: 'namra_owner', pooled: 'false' });
  const uri = (await api('GET', `/projects/${project.id}/connection_uri?${q}`)).uri;
  const u = new URL(uri); if (u.hostname.includes('-pooler')) u.hostname = u.hostname.replace('-pooler', ''); u.search = 'sslmode=require';
  console.log('Checking the restored copy...\n');
  const r = spawnSync('npm', ['run', 'restore:check', '--silent'], { cwd: root, shell: true, stdio: 'inherit', env: { ...process.env, RESTORE_CHECK_URL: u.toString() } });
  failed = r.status !== 0;
} catch (e) {
  failed = true; console.error(`Drill error: ${e.message}`);
} finally {
  if (keep) console.log(`\nBranch ${name} (${branchId}) kept. Delete it in the Neon console when you are done.`);
  else { try { await api('DELETE', `/projects/${project.id}/branches/${branchId}`); console.log(`\nTemporary branch ${name} deleted.`); } catch (e) { console.error(`\nCould NOT delete the temporary branch ${name} (${branchId}): ${e.message}. Delete it in the Neon console.`); failed = true; } }
}
process.exit(failed ? 1 : 0);
