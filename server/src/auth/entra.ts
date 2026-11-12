import type { Express, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import * as oidc from 'openid-client';
import type { Config } from '../config.js';
import { getPool, UNIQUE_VIOLATION } from '../db.js';
import { normalizeEmployeeCode } from '../domain/employeeCode.js';
import { cookieOptions, readCookie } from './cookies.js';
import { safeNext } from './safeNext.js';
import { signingKey, verifyKeys } from './keys.js';
import { createSession, endSession, rolesFor, sessionUser } from './sessions.js';
import { sign, verify } from './signing.js';
import { ADMIN_ROLE, type AuthUser } from './types.js';

/**
 * AUTH_MODE=entra: Microsoft Entra ID sign-in (OpenID Connect authorization code flow + PKCE, confidential client).
 * The identity is `oid` from the verified ID token; the employee code comes from Microsoft Graph (`employeeId`),
 * never from anything the browser supplies. After the callback the app issues its own signed session cookie.
 */
/** One cookie PER sign-in attempt, named by its state: a second tap, another tab or a stale page can never overwrite (and lose the `next` of) a flow in progress. */
const AUTH_COOKIE_PREFIX = 'namra_auth_';
const MAX_PENDING_FLOWS = 6;
const STATE_RE = /^[A-Za-z0-9_-]{16,128}$/;
const AUTH_TTL_MS = 10 * 60 * 1000;
const SCOPE = 'openid profile email User.Read';
const FAIL = '/login?error=signin_failed';

/** Test seams only: the real service is always login.microsoftonline.com over https. */
export interface EntraOptions { authorityBase?: string; graphBase?: string; allowInsecure?: boolean }

interface AuthState { s: string; n: string; v: string; next: string | null; exp: number }

class SignInRejected extends Error {}
const reject = (why: string) => new SignInRejected(why);

export function mountEntra(app: Express, config: Config, opts: EntraOptions = {}): void {
  const e = config.entra;
  if (!e) throw new Error('mountEntra called without ENTRA_* settings');
  const authority = (opts.authorityBase ?? 'https://login.microsoftonline.com').replace(/\/$/, '');
  const graphBase = (opts.graphBase ?? 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
  const issuer = `${authority}/${e.tenantId}/v2.0`;
  const jwksUri = `${authority}/${e.tenantId}/discovery/v2.0/keys`;
  const oc = new oidc.Configuration({
    issuer,
    authorization_endpoint: `${authority}/${e.tenantId}/oauth2/v2.0/authorize`,
    token_endpoint: `${authority}/${e.tenantId}/oauth2/v2.0/token`,
    jwks_uri: jwksUri,
    end_session_endpoint: `${authority}/${e.tenantId}/oauth2/v2.0/logout`,
    response_types_supported: ['code'],
    id_token_signing_alg_values_supported: ['RS256'],
  }, e.clientId, {}, oidc.ClientSecretPost(e.clientSecret));
  if (opts.allowInsecure) oidc.allowInsecureRequests(oc);
  const keys: JWTVerifyGetKey = createRemoteJWKSet(new URL(jwksUri), { cacheMaxAge: 60 * 60 * 1000, cooldownDuration: 30_000 });
  const authCookie = (extra = {}) => cookieOptions(config, { httpOnly: true, sameSite: 'lax', path: '/auth', ...extra });   // Lax: Microsoft redirects back cross-site
  const siteRoot = new URL(e.redirectUri).origin + '/';

  app.get('/auth/login', async (req: Request, res: Response) => {
    const verifier = oidc.randomPKCECodeVerifier();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const next = safeNext(typeof req.query.next === 'string' ? req.query.next : null);
    // Already signed in (valid session): there is nothing to sign in to. Go straight to the target, no second Microsoft round trip.
    const current = sessionUser(req);
    if (current) { res.set('Cache-Control', 'no-store'); return res.redirect(next ?? (current.roles.includes(ADMIN_ROLE) ? '/admin' : '/votes')); }
    pruneFlows(req, res);
    const payload: AuthState = { s: state, n: nonce, v: verifier, next, exp: Date.now() + AUTH_TTL_MS };
    res.cookie(AUTH_COOKIE_PREFIX + state, sign(signingKey(config, 'authflow'), payload), authCookie({ maxAge: AUTH_TTL_MS }));
    res.set('Cache-Control', 'no-store');
    res.redirect(oidc.buildAuthorizationUrl(oc, {
      redirect_uri: e.redirectUri, scope: SCOPE, response_type: 'code', state, nonce, prompt: 'select_account',
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
    }).href);
  });

  app.get('/auth/callback', async (req: Request, res: Response) => {
    const stateParam = typeof req.query.state === 'string' && STATE_RE.test(req.query.state) ? req.query.state : null;
    const raw = stateParam ? readCookie(req, AUTH_COOKIE_PREFIX + stateParam) : undefined;
    if (stateParam) res.clearCookie(AUTH_COOKIE_PREFIX + stateParam, authCookie());   // single use, whatever happens next
    res.set('Cache-Control', 'no-store');
    try {
      const st = raw ? verify<AuthState>(verifyKeys(config, 'authflow'), raw) : null;
      if (!st || typeof st.exp !== 'number' || st.exp < Date.now()) throw reject('missing or expired auth cookie');
      if (st.s !== stateParam) throw reject('state does not match its cookie');
      if (typeof req.query.error === 'string') throw reject(`provider error ${req.query.error.slice(0, 40)}`);

      // The library checks state, nonce, PKCE, issuer and audience of the ID token. The redirect URI is the configured one
      // (behind the Worker the request URL is an internal http address, so it is never taken from the request).
      const callbackUrl = new URL(e.redirectUri);
      callbackUrl.search = new URL(req.originalUrl, 'http://x.invalid').search;
      const tokens = await oidc.authorizationCodeGrant(oc, callbackUrl, { pkceCodeVerifier: st.v, expectedState: st.s, expectedNonce: st.n, idTokenExpected: true });
      if (!tokens.id_token) throw reject('no id_token');

      // The library does not verify the signature; do it ourselves against the tenant's published keys.
      const { payload: claims } = await jwtVerify(tokens.id_token, keys, { issuer, audience: e.clientId, algorithms: ['RS256'] });
      if (claims.tid !== e.tenantId) throw reject('wrong tenant');
      if (claims.nonce !== st.n) throw reject('nonce mismatch');
      const oid = typeof claims.oid === 'string' ? claims.oid : '';
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(oid)) throw reject('no oid');
      const email = [claims.preferred_username, claims.email].find((v): v is string => typeof v === 'string' && v.includes('@'))?.trim().toLowerCase();
      if (!email) throw reject('no email');

      const graph = await readGraphProfile(graphBase, tokens.access_token, fetch);
      const roles = Array.isArray(claims.roles) ? (claims.roles as unknown[]) : [];
      // Admin = the app role in the token, or the account id in ADMIN_OIDS (SEC-11); email only as a documented fallback.
      // The session stores only what the IdP asserted; roles are recomputed on every request (auth/sessions.ts).
      const claimAdmin = roles.includes(ADMIN_ROLE);
      const user: AuthUser = {
        oid: oid.toLowerCase(), email,
        displayName: String(claims.name ?? graph.displayName ?? email).slice(0, 120) || email,
        roles: [],
        employeeCode: graph.employeeCode,
      };
      await upsertUser(user);
      await createSession(req, res, config, { oid: user.oid, email, claimAdmin });
      const admin = rolesFor(config, { claimAdmin, oid: user.oid, email }).length > 0;
      res.redirect(st.next ?? (admin ? '/admin' : '/votes'));
    } catch (err) {
      // Log the reason (never tokens or secrets); the browser only learns that sign-in failed.
      logRejected(err);
      res.redirect(FAIL);
    }
  });

  // Clear the app session, then end the Microsoft session and come back to the site root.
  app.get('/auth/logout', async (req: Request, res: Response) => {
    await endSession(req, res, config);
    res.set('Cache-Control', 'no-store');
    res.redirect(oidc.buildEndSessionUrl(oc, { post_logout_redirect_uri: siteRoot, client_id: e.clientId }).href);
  });
}

/** Drops expired pending-flow cookies and, past MAX_PENDING_FLOWS, the oldest ones, so repeated taps can't grow the Cookie header. */
function pruneFlows(req: Request, res: Response): void {
  const flows: { name: string; exp: number }[] = [];
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    const name = i > 0 ? part.slice(0, i).trim() : '';
    if (!name.startsWith(AUTH_COOKIE_PREFIX)) continue;
    let exp = 0;
    try { exp = (JSON.parse(Buffer.from(decodeURIComponent(part.slice(i + 1).trim()).split('.')[0], 'base64url').toString()) as { exp?: number }).exp ?? 0; } catch { /* unreadable: treat as expired */ }
    flows.push({ name, exp });
  }
  const live = flows.filter((f) => f.exp > Date.now()).sort((a, b) => b.exp - a.exp);
  const drop = [...flows.filter((f) => f.exp <= Date.now()), ...live.slice(MAX_PENDING_FLOWS - 1)];
  for (const f of drop) res.clearCookie(f.name, { httpOnly: true, sameSite: 'lax', path: '/auth' });
}

/** Graph `GET /me?$select=employeeId,displayName,mail`. Any failure means "no code" (-> not_member), never a failed sign-in. */
async function readGraphProfile(base: string, accessToken: string, f: typeof fetch): Promise<{ employeeCode: string | null; displayName: string | null }> {
  try {
    const r = await f(`${base}/me?$select=employeeId,displayName,mail`, { headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' } });
    if (!r.ok) { console.warn(`[entra] Graph /me returned HTTP ${r.status}; user has no employee code`); return { employeeCode: null, displayName: null }; }
    const j = (await r.json()) as { employeeId?: unknown; displayName?: unknown };
    const employeeCode = normalizeEmployeeCode(j.employeeId);
    if (!employeeCode) console.warn(`[entra] employeeId ${j.employeeId == null ? 'absent' : 'present but not a valid code'}; user will be not_member`);
    return { employeeCode, displayName: typeof j.displayName === 'string' ? j.displayName : null };
  } catch (e) {
    console.warn(`[entra] Graph /me failed (${e instanceof Error ? e.message.slice(0, 100) : 'error'}); user has no employee code`);
    return { employeeCode: null, displayName: null };
  }
}

async function upsertUser(u: AuthUser): Promise<void> {
  const pool = getPool();
  const run = () => pool.query(
    `INSERT INTO users (entra_oid, email, display_name, employee_code) VALUES ($1, $2, $3, $4)
     ON CONFLICT (entra_oid) DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name, employee_code = EXCLUDED.employee_code`,
    [u.oid, u.email, u.displayName, u.employeeCode]);
  try { await run(); } catch (err) {
    if ((err as { code?: string }).code !== UNIQUE_VIOLATION) throw err;
    // Another row already owns this email under a different oid (e.g. a pre-Entra demo identity). Keep it (campaigns
    // reference it) but free the email so the real Microsoft identity can take it.
    await pool.query(`UPDATE users SET email = 'superseded-' || left(entra_oid::text, 8) || '+' || email WHERE email = $1 AND entra_oid <> $2`, [u.email, u.oid]);
    await run();
  }
}

/**
 * Logs why a sign-in failed (never tokens or secrets). Microsoft's error text carries an AADSTS code; two of them mean the
 * app's own client secret is no good, which is an operator problem, not a user problem, so they get a loud, explicit line.
 */
export function describeSignInFailure(err: unknown): { line: string; secretProblem: boolean } {
  const e = err as { message?: string; error?: string; error_description?: string; cause?: { error?: string; error_description?: string } };
  const text = [e?.error_description, e?.cause?.error_description, e?.error, e?.cause?.error, e?.message].filter((x): x is string => typeof x === 'string').join(' ');
  const code = /AADSTS(\d{4,7})/.exec(text)?.[1];
  if (code === '7000222' || code === '7000215') {
    return {
      secretProblem: true,
      line: `[entra] CLIENT SECRET ${code === '7000222' ? 'EXPIRED' : 'INVALID'} (AADSTS${code}): Microsoft rejected the app's client secret, so nobody can sign in. Create a new client secret in the Entra app registration and update ENTRA_CLIENT_SECRET (and ENTRA_SECRET_EXPIRES_AT).`,
    };
  }
  const why = err instanceof Error ? err.message.slice(0, 200) : 'unknown';
  return { secretProblem: false, line: `[entra] sign-in rejected: ${why}${code ? ` (AADSTS${code})` : ''}` };
}

function logRejected(err: unknown): void {
  const d = describeSignInFailure(err);
  if (d.secretProblem) console.error(d.line); else console.warn(d.line);
}
