// End-to-end check of worker/src/forward.ts against the REAL production image (what Cloudflare can't do locally on Windows).
// Starts the image (dev auth, local compose Postgres), puts a tiny proxy in front that applies toContainerRequest(),
// then: dev login -> create campaign (JSON POST) -> GET it -> upload candidate photo (multipart) -> fetch the photo.
// Usage: npm run db:up && docker build -t namra-voting-demo:local . && node scripts/forward-check.mjs
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { toContainerRequest } from '../worker/src/forward.ts';

process.loadEnvFile(new URL('../.env', import.meta.url));
const db = new URL(process.env.DATABASE_URL); db.hostname = 'host.docker.internal';
const sh = (...a) => spawnSync('docker', a, { encoding: 'utf8' });
sh('rm', '-f', 'nv-fwd');
const run = sh('run', '-d', '--name', 'nv-fwd', '-p', '8098:8080', '-e', 'NODE_ENV=development', '-e', 'AUTH_MODE=dev', '-e', 'PORT=8080', '-e', 'UPLOAD_DIR=/tmp/uploads',
  '-e', `DATABASE_URL=${db}`, '-e', `SESSION_SECRET=${process.env.SESSION_SECRET}`, '-e', 'PUBLIC_BASE_URL=https://fwd.example.dev', 'namra-voting-demo:local');
if (run.status !== 0) { console.error(run.stderr); process.exit(1); }

const PUBLIC = 'https://fwd.example.dev';
const proxy = http.createServer(async (req, res) => {
  try {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
    const forwarded = toContainerRequest(new Request(PUBLIC + req.url, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host')), body }));
    const r = await fetch(new Request(`http://127.0.0.1:8098${new URL(forwarded.url).pathname}${new URL(forwarded.url).search}`, forwarded));
    const out = new Headers(r.headers); out.delete('content-encoding'); out.delete('content-length');
    res.writeHead(r.status, Object.fromEntries(out)); res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.writeHead(502); res.end(String(e)); }
}).listen(8097);

let jar = {};
const call = async (method, path, { json, form } = {}) => {
  const headers = { cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ') };
  if (json) headers['content-type'] = 'application/json';
  if (method !== 'GET' && jar.namra_csrf) headers['x-csrf-token'] = jar.namra_csrf;
  const r = await fetch(`http://127.0.0.1:8097${path}`, { method, headers, body: form ?? (json ? JSON.stringify(json) : undefined), redirect: 'manual' });
  for (const sc of r.headers.getSetCookie()) { const [kv] = sc.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
  return r;
};
const ok = (cond, msg) => { console.log(cond ? 'PASS' : 'FAIL', msg); if (!cond) process.exitCode = 1; };
try {
  for (let i = 0; i < 40; i++) { const r = await fetch('http://127.0.0.1:8097/api/csrf').catch(() => null); if (r?.ok) break; await new Promise((r) => setTimeout(r, 1000)); }
  await call('GET', '/api/csrf');
  const users = (await (await call('GET', '/api/dev/users')).json()).users;
  const alice = users.find((u) => u.displayName === 'Alice Admin');
  ok((await call('POST', '/api/dev/login', { json: alice })).status === 200, 'dev login (JSON POST)');
  const created = await call('POST', '/api/campaigns', { json: { title: 'Forward check ' + Date.now(), description: 'x' } });
  const c = await created.json();
  ok(created.status === 201 || created.status === 200, `create campaign -> ${created.status}`);
  const got = await call('GET', `/api/campaigns/${c.id}`);
  ok(got.status === 200 && (await got.json()).id === c.id, 'GET the new campaign');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAnklEQVRoge2SUQkAQBSD1sn+DRbqQtyHPBgYwMlSOE10g24AesXuQtwlukE3AL1idyHuEt2gG4BesbsQd4lu0A1Ar9hdiLtEN+gGoFfsLsRdoht0A9ArdhfiLtENugHoFbsLcZfoBt0A9IrdhbhLdINuAHrF7kLcJbpBNwC9Ynch7hLdoBuAXrG7EHeJbtANQK/YXYi7RDfoBqBX/OEByzghHhwNVhQAAAAASUVORK5CYII=', 'base64');
  const fd = new FormData(); fd.set('name', 'Pat Photo'); fd.set('photo', new File([png], 'p.png', { type: 'image/png' }));
  const up = await call('POST', `/api/campaigns/${c.id}/candidates`, { form: fd });
  ok(up.status === 201 || up.status === 200, `upload candidate photo (multipart) -> ${up.status} ${up.status > 299 ? await up.clone().text() : ''}`);
  const detail = await (await call('GET', `/api/campaigns/${c.id}`)).json();
  const photo = detail.candidates?.[0]?.photo_url;
  const pr = photo ? await call('GET', photo) : null;
  ok(pr?.status === 200 && pr.headers.get('content-type')?.startsWith('image/'), `fetch photo ${photo} -> ${pr?.status}`);
  const redir = await call('GET', '/api/nonexistent-redirect-probe');
  ok(redir.status !== 0, `redirect:'manual' passthrough (status ${redir.status})`);
} catch (e) { console.error('ERROR', e); process.exitCode = 1; }
finally {
  proxy.close();
  const l = sh('logs', '--tail', '15', 'nv-fwd');
  console.log((l.stdout + l.stderr).split('\n').filter((x) => !/SSL|pg-conn|libpq|prepare|trace-warn|^\s*$/i.test(x)).slice(-8).join('\n'));
  sh('rm', '-f', 'nv-fwd');
}
