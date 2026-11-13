// Pre-deploy snapshot. Creates a Neon branch of the live (default) branch AS OF NOW, so a deploy whose migration goes wrong can be rolled
// back instantly by restoring the live branch from it (docs/operations.md, "Rolling back a deploy"). A branch is a copy-on-write fork: it
// is created in seconds, copies nothing up front, and does not touch the live database.
//
//   node scripts/neon-snapshot.mjs [--label <text>] [--keep <n>]
//
//   --label  added to the branch name (the Deploy workflow passes the short commit sha)
//   --keep   how many pre-deploy-* snapshot branches to keep (default 3; older ones are deleted AFTER the new one exists). 0 = delete none.
//
// Needs NEON_API_KEY (and NEON_PROJECT_ID, or a single/namra-voting-demo project). Never prints credentials. Exits non-zero if the
// snapshot could not be made, so the Deploy workflow stops BEFORE any migration runs.
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* CI: the environment has it */ }
const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const label = String(arg('--label', '')).replace(/[^A-Za-z0-9-]/g, '').slice(0, 20);
const keep = Number(arg('--keep', '3'));
const key = process.env.NEON_API_KEY;
if (!key) { console.error('NEON_API_KEY is missing: no snapshot, so no deploy.'); process.exit(1); }
if (!Number.isInteger(keep) || keep < 0) { console.error('--keep must be a whole number'); process.exit(1); }

const api = async (method, p, body) => {
  const r = await fetch(`https://console.neon.tech/api/v2${p}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} -> HTTP ${r.status}: ${j.message ?? JSON.stringify(j).slice(0, 200)}`);
  return j;
};
const summary = (line) => { console.log(line); if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, line + '\n'); };

try {
  const projects = (await api('GET', '/projects?limit=100')).projects;
  const project = projects.find((x) => x.id === process.env.NEON_PROJECT_ID) ?? projects.find((x) => x.name === 'namra-voting-demo') ?? (projects.length === 1 ? projects[0] : null);
  if (!project) throw new Error('Could not tell which Neon project is live: set NEON_PROJECT_ID');
  const branches = (await api('GET', `/projects/${project.id}/branches`)).branches;
  const live = branches.find((b) => b.default);
  if (!live) throw new Error('The project has no default (live) branch');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `pre-deploy-${stamp}${label ? `-${label}` : ''}`;
  // No compute endpoint: the snapshot only has to exist. One is added when (if) it is used for a rollback or an inspection.
  const created = (await api('POST', `/projects/${project.id}/branches`, { branch: { name, parent_id: live.id } })).branch;
  summary(`### Pre-deploy snapshot\nNeon branch **${created.name}** (\`${created.id}\`) of the live branch \`${live.name}\`, as of ${created.created_at ?? stamp}.`);
  summary(`Roll back: Neon console -> Branches -> \`${live.name}\` -> Restore -> from branch \`${created.name}\` (docs/operations.md, "Rolling back a deploy").`);

  if (keep > 0) {
    const old = branches.filter((b) => b.name.startsWith('pre-deploy-') && b.id !== created.id && !b.default && !b.protected)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .slice(keep - 1);   // the new one counts towards `keep`
    for (const b of old) {
      try { await api('DELETE', `/projects/${project.id}/branches/${b.id}`); console.log(`Deleted the older snapshot ${b.name}`); }
      catch (e) { console.warn(`Could not delete the older snapshot ${b.name}: ${e.message} (harmless; delete it in the Neon console)`); }
    }
  }
} catch (e) {
  console.error(`Pre-deploy snapshot FAILED: ${e.message}`);
  process.exit(1);
}
