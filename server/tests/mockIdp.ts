import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';

/**
 * A local stand-in for login.microsoftonline.com + Microsoft Graph, so tests never call Microsoft.
 * It has its own RSA keypair, publishes the JWKS, and its token endpoint enforces what a real IdP enforces:
 * client secret, redirect_uri and the PKCE verifier (S256) against the challenge the test saw in /authorize.
 */
export interface Scenario {
  nonce: string;                       // nonce to put in the ID token (normally the one from /authorize)
  codeChallenge: string;               // challenge from /authorize
  claims?: Record<string, unknown>;    // overrides; a value of undefined removes the claim
  graph?: Record<string, unknown> | { __status: number };   // /me response
  signWithOtherKey?: boolean;
}

export interface MockIdp {
  base: string; tenant: string; clientId: string; secret: string; redirectUri: string; issuer: string;
  register(code: string, s: Scenario): void;
  tokenRequests: URLSearchParams[];
  close(): Promise<void>;
}

export async function startMockIdp(o: { tenant: string; clientId: string; secret: string; redirectUri: string }): Promise<MockIdp> {
  const kp = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: 'mock-1', alg: 'RS256', use: 'sig' };
  const scenarios = new Map<string, Scenario>();
  const tokenRequests: URLSearchParams[] = [];
  let base = '';

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && url.pathname === `/${o.tenant}/discovery/v2.0/keys`) { send(200, { keys: [jwk] }); return; }
    if (req.method === 'POST' && url.pathname === `/${o.tenant}/oauth2/v2.0/token`) {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const p = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      tokenRequests.push(p);
      const basic = req.headers.authorization?.startsWith('Basic ') ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString() : '';
      const secretOk = p.get('client_secret') === o.secret || basic.endsWith(`:${encodeURIComponent(o.secret)}`) || basic.endsWith(`:${o.secret}`);
      const sc = scenarios.get(p.get('code') ?? '');
      const challenge = crypto.createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
      if (!secretOk || p.get('grant_type') !== 'authorization_code' || p.get('redirect_uri') !== o.redirectUri || !sc || challenge !== sc.codeChallenge) {
        send(400, { error: 'invalid_grant', error_description: 'mock IdP: secret, redirect_uri, code or PKCE verifier did not match' }); return;
      }
      const now = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = {
        iss: `${base}/${o.tenant}/v2.0`, aud: o.clientId, tid: o.tenant, nonce: sc.nonce, iat: now, nbf: now - 5, exp: now + 3600,
        sub: 'pairwise-subject-abc', oid: '11111111-2222-4333-8444-555555555555', preferred_username: 'someone@namra.org.na', name: 'Some One', ...sc.claims,
      };
      for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
      const idToken = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'mock-1' }).sign(sc.signWithOtherKey ? other.privateKey : kp.privateKey);
      send(200, { token_type: 'Bearer', expires_in: 3599, scope: 'openid profile email User.Read', access_token: `at-${p.get('code')}`, id_token: idToken });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/graph/v1.0/me') {
      const code = (req.headers.authorization ?? '').replace('Bearer at-', '');
      const sc = scenarios.get(code);
      if (!sc || !req.headers.authorization?.startsWith('Bearer at-')) { send(401, { error: 'bad token' }); return; }
      const g = sc.graph ?? {};
      if ('__status' in g) { send(g.__status as number, { error: 'mock failure' }); return; }
      send(200, { displayName: 'Graph Name', mail: 'x@namra.org.na', ...g }); return;
    }
    send(404, { error: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base, tenant: o.tenant, clientId: o.clientId, secret: o.secret, redirectUri: o.redirectUri, issuer: `${base}/${o.tenant}/v2.0`,
    register: (code, s) => { scenarios.set(code, s); }, tokenRequests,
    close: () => new Promise<void>((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
