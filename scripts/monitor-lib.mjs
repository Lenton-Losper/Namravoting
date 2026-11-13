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
