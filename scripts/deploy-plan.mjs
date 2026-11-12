// Pure planning for scripts/cf-deploy.mjs (SEC-23): which secrets the ACTIVE auth mode needs, and whether this config may be
// deployed at all. No I/O, so it can be unit-tested (server/tests/unit/deployPlan.test.ts).

/** Reads a wrangler.jsonc: strips // and /* *\/ comments (outside strings) and trailing commas, then parses. */
export function parseJsonc(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\') { out += text[++i] ?? ''; } else if (c === '"') inStr = false;
    } else if (c === '"') { inStr = true; out += c; }
    else if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; }
    else if (c === '/' && text[i + 1] === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; }
    else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const BASE_SECRETS = ['DATABASE_URL', 'SESSION_SECRET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT'];
const MODE_SECRETS = { entra: ['ENTRA_CLIENT_SECRET'], demo: ['CF_ACCESS_AUD', 'DEMO_USERS'] };
const OPTIONAL_SECRETS = ['SESSION_SECRET_PREVIOUS', 'CSRF_SECRET'];

/**
 * @param env  the repo-root .env (plus the real environment)
 * @param vars the `vars` block of worker/wrangler.jsonc (what the deployed Worker will run with)
 * @returns { problems: string[], secrets: Record<string,string>, names: string[] } ; deploy only when `problems` is empty
 */
export function planDeploy(env, vars) {
  const problems = [];
  const mode = vars?.AUTH_MODE;
  if (vars?.NODE_ENV !== 'production') problems.push(`wrangler.jsonc must set NODE_ENV to "production" (it says ${JSON.stringify(vars?.NODE_ENV ?? null)})`);
  if (mode === 'dev' || !(mode in MODE_SECRETS)) problems.push(`wrangler.jsonc AUTH_MODE is ${JSON.stringify(mode ?? null)}: only "entra" or "demo" may be deployed, never the dev identity picker`);
  if (vars?.ALLOW_DEV_AUTH === 'true') problems.push('wrangler.jsonc must not set ALLOW_DEV_AUTH');

  const need = ['CLOUDFLARE_ACCOUNT_ID', ...(env.WRANGLER_OAUTH === '1' ? [] : ['CLOUDFLARE_API_TOKEN']), 'DEMO_DATABASE_URL', 'DEMO_SESSION_SECRET',
    'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ENDPOINT', ...(MODE_SECRETS[mode] ?? [])];
  for (const k of need) if (!env[k]) problems.push(`${k} is missing from .env`);
  if (env.DEMO_SESSION_SECRET && env.DEMO_SESSION_SECRET.length < 32) problems.push('DEMO_SESSION_SECRET must be at least 32 characters');

  // Only the secrets this mode uses are sent. (A demo-only secret never rides into an entra deployment, or the other way round.)
  const secrets = {
    DATABASE_URL: env.DEMO_DATABASE_URL, SESSION_SECRET: env.DEMO_SESSION_SECRET,
    R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY, R2_ENDPOINT: env.R2_ENDPOINT,
  };
  for (const k of MODE_SECRETS[mode] ?? []) secrets[k] = env[k];
  for (const k of OPTIONAL_SECRETS) if (env[k]) secrets[k] = env[k];
  for (const k of Object.keys(secrets)) if (!secrets[k]) delete secrets[k];
  return { problems, secrets, names: Object.keys(secrets).sort(), mode, baseSecrets: BASE_SECRETS };
}
