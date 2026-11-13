// Outside monitor: node scripts/monitor.mjs
// Checks the live app and alerts (workflow failure + optional webhook). See scripts/monitor-lib.mjs and docs/disaster-recovery.md.
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkApp, checkEntraToken, checkSecretExpiry, sendAlert, summarise } from './monitor-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = readFileSync(path.join(root, 'worker', 'wrangler.jsonc'), 'utf8');
const base = (process.env.MONITOR_URL || wrangler.match(/"PUBLIC_BASE_URL"\s*:\s*"([^"]+)"/)?.[1] || '').replace(/\/$/, '');
if (!base) { console.error('Cannot work out the app URL (set MONITOR_URL)'); process.exit(2); }

const checks = await checkApp(base);

// The Microsoft secret is tested hourly (the first run of each hour) and on a manual run, not every 15 minutes: it shows up in Entra's sign-in logs.
const setting = (k) => process.env[k] || wrangler.match(new RegExp(String.raw`^\s*"${k}"\s*:\s*"([^"]+)"`, 'm'))?.[1];
if (new Date().getUTCMinutes() < 15 || process.env.EVENT_NAME === 'workflow_dispatch') {
  checks.push(await checkEntraToken({ tenantId: setting('ENTRA_TENANT_ID'), clientId: setting('ENTRA_CLIENT_ID'), clientSecret: process.env.ENTRA_CLIENT_SECRET }));
  checks.push(checkSecretExpiry(setting('ENTRA_SECRET_EXPIRES_AT')));
}
const { lines, failing, warning, ok } = summarise(checks);
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### NamRA Voting monitor\n```\n' + lines.join('\n') + '\n```\n');
if (!ok || warning.length) {
  const title = ok ? 'NamRA Voting: warning' : 'NamRA Voting: PROBLEM';
  const sent = await sendAlert(process.env.ALERT_WEBHOOK_URL, title, [...failing, ...warning].map((c) => `${c.name}: ${c.detail}`));
  if (process.env.ALERT_WEBHOOK_URL) console.log(sent ? 'Alert sent to the webhook.' : 'The webhook alert could not be sent.');
  for (const c of failing) console.log(`::error::${c.name}: ${c.detail}`);
  for (const c of warning) console.log(`::warning::${c.name}: ${c.detail}`);
}
process.exit(ok ? 0 : 1);
