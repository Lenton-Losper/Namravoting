// Smoke test of a running install under a base path (CI job "hosting", and usable on the VM after install):
//   node scripts/hosting-smoke.mjs [http://127.0.0.1:8080/voting-app]
// Uses AUTH_MODE=email-demo with DEMO_USERS (smoke.admin@namra.org.na is a CampaignAdmin), so it proves the app, not Microsoft sign-in.
// Flow: page + assets + deep link, health, admin signs in, creates a campaign (with a photo), starts it, a voter signs in and votes.
const BASE = (process.argv[2] ?? 'http://127.0.0.1:8080/voting-app').replace(/\/$/, '');
const BASE_PATH = new URL(BASE).pathname.replace(/\/$/, '');
const ORIGIN = new URL(BASE).origin;
const ADMIN = 'smoke.admin@namra.org.na';
const VOTER = 'smoke.voter@namra.org.na';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let failures = 0;
const ok = (label, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`); if (!cond) failures++; return cond; };

class Browser {
  jar = {}; csrf = null; setCookies = [];
  cookie() { return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res) { for (const c of res.headers.getSetCookie?.() ?? []) { this.setCookies.push(c); const [kv] = c.split(';'); const i = kv.indexOf('='); this.jar[kv.slice(0, i)] = kv.slice(i + 1); } }
  async raw(method, url, { body, headers = {} } = {}) {
    const res = await fetch(url, { method, headers: { ...headers, cookie: this.cookie() }, body, redirect: 'manual' });
    this.store(res); return res;
  }
  async api(method, path, body) {
    const headers = {}; let payload;
    if (method !== 'GET') {
      if (!this.csrf) this.csrf = (await (await this.raw('GET', `${BASE}/api/csrf`)).json()).token;
      headers['x-csrf-token'] = this.csrf;
    }
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await this.raw(method, `${BASE}${path}`, { body: payload, headers });
    const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  }
  async login(email) { const r = await this.api('POST', '/api/email-login', { email }); this.csrf = null; return r; }
}

// ---- 1. the site itself
const anon = new Browser();
const home = await anon.raw('GET', `${BASE}/`);
const html = await home.text();
ok('GET /voting-app/ serves the web page', home.status === 200 && html.includes('<div id="root">'), `HTTP ${home.status}`);
const asset = html.match(/(?:src|href)="([^"]*\/assets\/[^"]+)"/)?.[1];
ok(`the page loads its files from ${BASE_PATH}/assets/`, !!asset && asset.startsWith(`${BASE_PATH}/assets/`), asset);
if (asset) ok('an asset file is served', (await anon.raw('GET', ORIGIN + asset)).status === 200);
ok('a deep link (/votes) serves the web page', (await anon.raw('GET', `${BASE}/votes`)).status === 200);
const health = await anon.raw('GET', `${BASE}/api/health`);
ok('health check answers 200 {"ok":true}', health.status === 200 && (await health.json()).ok === true, `HTTP ${health.status}`);
ok('nothing is served outside the base path (/api/health at the root is 404)', (await anon.raw('GET', `${ORIGIN}/api/health`)).status === 404);
const csrf = await anon.raw('GET', `${BASE}/api/csrf`);
ok('cookies are scoped to the base path', csrf.status === 200 && anon.setCookies.length > 0 && anon.setCookies.every((c) => new RegExp(`Path=${BASE_PATH}(;|$)`, 'i').test(c)), anon.setCookies.map((c) => c.split(';').filter((x) => /Path/i.test(x)).join('')).join(' '));

// ---- 2. admin: sign in, create a campaign with a photo, start it
const admin = new Browser();
const login = await admin.login(ADMIN);
if (!ok('admin signs in', login.status === 200 && login.body.user?.roles?.includes('CampaignAdmin'), `HTTP ${login.status}`)) process.exit(1);
const camp = await admin.api('POST', '/api/campaigns', { title: 'Hosting smoke test', eligibility: 'all' });
if (!ok('admin creates a campaign', camp.status === 201, `HTTP ${camp.status}`)) process.exit(1);
ok(`the share link is under ${BASE_PATH}`, camp.body.share_url?.includes(`${BASE_PATH}/v/`), camp.body.share_url);
const pos = await admin.api('POST', `/api/campaigns/${camp.body.id}/positions`, { title: 'Chairperson' });
ok('admin adds a position', pos.status === 201, `HTTP ${pos.status}`);
const cand = [];
for (const [i, name] of ['Ann Example', 'Ben Example'].entries()) {
  const f = new FormData(); f.append('name', name); f.append('position_id', pos.body.id); f.append('region', 'Khomas');
  if (i === 0) f.append('photo', new Blob([PNG], { type: 'image/png' }), 'p.png');
  const r = await admin.api('POST', `/api/campaigns/${camp.body.id}/candidates`, f);
  ok(`admin adds candidate ${name}`, r.status === 201, `HTTP ${r.status}`); cand.push(r.body);
}
ok(`a candidate photo link is under ${BASE_PATH}/api/photos/`, cand[0]?.photo_url?.startsWith(`${BASE_PATH}/api/photos/`), cand[0]?.photo_url);
const qr = await admin.raw('GET', `${BASE}/api/campaigns/${camp.body.id}/qr.png`);
ok('the QR code is served', qr.status === 200 && (qr.headers.get('content-type') ?? '').includes('image/png'));
const start = await admin.api('POST', `/api/campaigns/${camp.body.id}/start`);
ok('admin starts the campaign', start.status === 200, `HTTP ${start.status}`);

// ---- 3. voter: sign in, open the ballot, vote, see the receipt
const voter = new Browser();
ok('voter signs in', (await voter.login(VOTER)).status === 200);
const token = camp.body.share_token;
const ballot = await voter.api('GET', `/api/vote/${token}`);
ok('voter opens the ballot', ballot.status === 200 && ballot.body.positions?.length === 1, `HTTP ${ballot.status}`);
const ballotCand = ballot.body.candidates ?? [];
const photo = ballotCand.find((c) => c.photoUrl)?.photoUrl;
ok('the ballot photo link is under the base path and loads', !!photo && photo.startsWith(`${BASE_PATH}/api/photos/`) && (await voter.raw('GET', ORIGIN + photo)).status === 200, photo);
const target = ballotCand.find((c) => c.name === 'Ann Example');
const cast = await voter.api('POST', `/api/vote/${token}/positions/${ballot.body.positions[0].id}`, { candidateId: target?.id });
ok('voter casts a vote and gets a receipt code', cast.status === 201 && /^UV-/.test(cast.body.receiptCode ?? ''), `HTTP ${cast.status} ${cast.body.receiptCode ?? ''}`);
const again = await voter.api('POST', `/api/vote/${token}/positions/${ballot.body.positions[0].id}`, { candidateId: target?.id });
ok('voting twice is refused (409)', again.status === 409, `HTTP ${again.status}`);
const mine = await voter.api('GET', '/api/vote');
ok('My votes lists the campaign', mine.body.campaigns?.some((c) => c.shareToken === token));
ok('a voter has no results route (404)', (await voter.api('GET', `/api/vote/${token}/results`)).status === 404);
ok('a voter cannot reach admin routes', [403, 404].includes((await voter.api('GET', `/api/campaigns/${camp.body.id}/results`)).status));

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
