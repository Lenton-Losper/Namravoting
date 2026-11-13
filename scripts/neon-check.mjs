// Read-only: reports how far back the Neon database can be restored (point-in-time recovery window) and what else matters for recovery.
// Changes nothing. Uses NEON_API_KEY from the repo-root .env. Never prints credentials.
//   node scripts/neon-check.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* CI: variables come from the environment */ }
const key = process.env.NEON_API_KEY;
if (!key) { console.error('NEON_API_KEY is missing (.env)'); process.exit(1); }
const api = async (p) => {
  const r = await fetch(`https://console.neon.tech/api/v2${p}`, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GET ${p} -> HTTP ${r.status}: ${j.message ?? ''}`);
  return j;
};

const projects = (await api('/projects?limit=100')).projects;
const p = projects.find((x) => x.id === process.env.NEON_PROJECT_ID) ?? projects.find((x) => x.name === 'namra-voting-demo') ?? projects[0];
if (!p) { console.error('No Neon project found for this API key'); process.exit(1); }
const detail = (await api(`/projects/${p.id}`)).project;
const branches = (await api(`/projects/${p.id}/branches`)).branches;
const hours = detail.history_retention_seconds == null ? null : detail.history_retention_seconds / 3600;
console.log(`Project: ${detail.name} (${detail.id}), region ${detail.region_id}, Postgres ${detail.pg_version}`);
console.log(`Point-in-time recovery window (history_retention_seconds): ${detail.history_retention_seconds ?? 'unknown'} seconds${hours == null ? '' : ` = ${hours} hours (${(hours / 24).toFixed(1)} days)`}`);
console.log(`Branches: ${branches.map((b) => `${b.name}${b.default ? ' (default)' : ''}`).join(', ')}`);
console.log(`Plan / quota hints: owner ${detail.owner_id ?? 'n/a'}, created ${detail.created_at}`);
if (hours != null && hours < 24) console.log('NOTE: the window is under 24 hours. A mistake noticed the next morning could not be rolled back. Raise it in the Neon console (Settings > Storage > Restore window) if the plan allows, or rely on the sealed-result copies and the daily export described in docs/disaster-recovery.md.');
