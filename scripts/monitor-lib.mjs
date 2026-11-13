// Outside monitoring of the live app (business-logic items 6 and 12). Runs from GitHub Actions on a schedule (.github/workflows/monitor.yml),
// i.e. from OUTSIDE the app and OUTSIDE Cloudflare, so it still works when the app is down. No dependencies; fetch is injectable for tests.

/** Each check returns { name, ok, detail }. `detail` never contains a secret. */

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/** The app answers, and the sign-in starts a Microsoft sign-in. A cold start (the container waking up) gets a few patient retries. */
export async function checkApp(base, { fetchImpl = fetch, sleep = sleepReal, retries = 4, delayMs = 15_000 } = {}) {
  const out = [];
  let last = 'no answer';
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetchImpl(`${base}/api/csrf`, { signal: AbortSignal.timeout(20_000) });
      const j = await r.json().catch(() => ({}));
      if (r.status === 200 && typeof j.token === 'string') { last = ''; break; }
      last = `HTTP ${r.status}`;
    } catch (e) { last = e.name === 'TimeoutError' ? 'timed out after 20 s' : String(e.message ?? e).slice(0, 120); }
    if (i < retries) await sleep(delayMs);
  }
  out.push({ name: 'App answers', ok: last === '', detail: last === '' ? `${base} is up` : `${base}: ${last}` });
  if (last !== '') return out;   // no point testing the sign-in redirect of an app that is down

  try {
    const r = await fetchImpl(`${base}/auth/login`, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    const loc = r.headers.get('location') ?? '';
    const ok = r.status === 302 && loc.startsWith('https://login.microsoftonline.com/');
    out.push({ name: 'Sign-in redirects to Microsoft', ok, detail: ok ? 'redirect to login.microsoftonline.com' : `HTTP ${r.status}${loc ? ` to ${new URL(loc, base).origin}` : ''}` });
  } catch (e) { out.push({ name: 'Sign-in redirects to Microsoft', ok: false, detail: String(e.message ?? e).slice(0, 120) }); }
  return out;
}

/** Plain text report plus the failing lines, for the log and the alert. */
export function summarise(checks) {
  const lines = checks.map((c) => `${c.ok ? 'OK  ' : c.warn ? 'WARN' : 'FAIL'}  ${c.name}: ${c.detail}`);
  const failing = checks.filter((c) => !c.ok && !c.warn);
  const warning = checks.filter((c) => !c.ok && c.warn);
  return { lines, failing, warning, ok: failing.length === 0 };
}

/** Sends the alert to a webhook (Microsoft Teams / Slack style `{ text }`), if one is configured. Never throws. */
export async function sendAlert(webhook, title, lines, { fetchImpl = fetch } = {}) {
  if (!webhook) return false;
  try {
    const r = await fetchImpl(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: `${title}\n\n${lines.join('\n')}` }), signal: AbortSignal.timeout(15_000) });
    return r.ok;
  } catch { return false; }
}

// ---- Entra client secret (business-logic item 12) ---------------------------------------------------------------------------------

/** What an Entra error code means to the person who gets the alert. Only the code is ever reported, never a token or the secret. */
const ENTRA_CODES = {
  7000222: 'the client secret has EXPIRED: nobody can sign in until a new one is created and set',
  7000215: 'the client secret is INVALID (wrong value, or the wrong secret id was copied)',
  700016: 'the application (client) id is not found in this tenant',
  90002: 'the tenant id is not found',
  7000218: 'the app registration does not accept this kind of sign-in',
};

/**
 * Exercises the SAME request the app makes with the secret (a client-credentials token), so an expired or wrong secret is found before a person
 * hits the sign-in. The token itself is discarded without being read further.
 */
export async function checkEntraToken({ tenantId, clientId, clientSecret }, { fetchImpl = fetch, authority = 'https://login.microsoftonline.com' } = {}) {
  const name = 'Microsoft sign-in secret works';
  if (!clientSecret) return { name, ok: false, warn: true, detail: 'ENTRA_CLIENT_SECRET is not set for the monitor (repository secret): the secret was not tested' };
  try {
    const r = await fetchImpl(`${authority}/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(20_000),
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && typeof j.access_token === 'string') return { name, ok: true, detail: 'Microsoft issued a token for the app' };
    const code = Array.isArray(j.error_codes) ? j.error_codes[0] : undefined;
    return { name, ok: false, detail: code ? `AADSTS${code}: ${ENTRA_CODES[code] ?? 'Microsoft refused the token request'}` : `HTTP ${r.status}: Microsoft refused the token request` };
  } catch (e) {
    // Microsoft being unreachable from here is not proof that the secret is bad: report it as a warning.
    return { name, ok: false, warn: true, detail: `could not reach Microsoft (${String(e.message ?? e).slice(0, 80)}); the secret was not tested` };
  }
}

const DAY = 86_400_000;
/** Warn 30 days before the secret expires, fail (alert) in the last 7 days and after it has expired. */
export function checkSecretExpiry(expiresAt, now = new Date(), { warnDays = 30, failDays = 7 } = {}) {
  const name = 'Client secret expiry';
  if (!expiresAt) return { name, ok: false, warn: true, detail: 'the expiry date is not tracked: set the repository variable ENTRA_SECRET_EXPIRES_AT (YYYY-MM-DD) from the Entra app registration' };
  const plain = /^\d{4}-\d{2}-\d{2}$/.test(expiresAt);
  const at = new Date(plain ? `${expiresAt}T23:59:59Z` : expiresAt);
  // a calendar date that does not exist (2027-02-30) must not silently roll over into March
  if (Number.isNaN(at.getTime()) || (plain && at.toISOString().slice(0, 10) !== expiresAt)) return { name, ok: false, warn: true, detail: `ENTRA_SECRET_EXPIRES_AT "${expiresAt}" is not a date (use YYYY-MM-DD)` };
  const days = Math.ceil((at.getTime() - now.getTime()) / DAY);
  if (days <= 0) return { name, ok: false, detail: `the secret EXPIRED ${Math.abs(days) === 0 ? 'today' : `${Math.abs(days)} day(s) ago`}: create a new one in the Entra app registration and update ENTRA_CLIENT_SECRET` };
  if (days <= failDays) return { name, ok: false, detail: `the secret expires in ${days} day(s) (${at.toISOString().slice(0, 10)}): create a new one now` };
  if (days <= warnDays) return { name, ok: false, warn: true, detail: `the secret expires in ${days} days (${at.toISOString().slice(0, 10)}): create a new one soon` };
  return { name, ok: true, detail: `${days} days left (expires ${at.toISOString().slice(0, 10)})` };
}
