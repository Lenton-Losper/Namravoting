import type { RequestHandler } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

/**
 * Cloudflare Access gate for AUTH_MODE=demo. Every request must carry a valid `Cf-Access-Jwt-Assertion`
 * header: RS256 signature checked against the team's published keys, audience and expiry enforced.
 * The verified `email` claim (lower-cased) is left in res.locals.accessEmail: it is the demo identity (auth/demoAuth.ts).
 */
export interface AccessVerifier { verify(token: string): Promise<{ email: string | null }> }

/** "myteam" or "myteam.cloudflareaccess.com" -> "myteam.cloudflareaccess.com" */
export function normalizeTeamDomain(raw: string): string {
  const d = raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return d.includes('.') ? d : `${d}.cloudflareaccess.com`;
}

export function createAccessVerifier(opts: { teamDomain: string; aud: string; keys?: JWTVerifyGetKey }): AccessVerifier {
  const team = normalizeTeamDomain(opts.teamDomain);
  // createRemoteJWKSet caches the keys (and refreshes on an unknown key id, with a cooldown).
  const keys = opts.keys ?? createRemoteJWKSet(new URL(`https://${team}/cdn-cgi/access/certs`), { cacheMaxAge: 60 * 60 * 1000, cooldownDuration: 30_000 });
  return {
    async verify(token: string) {
      const { payload } = await jwtVerify(token, keys, { issuer: `https://${team}`, audience: opts.aud, algorithms: ['RS256'] });   // checks exp/nbf too
      const email = typeof payload.email === 'string' && payload.email.includes('@') ? payload.email.trim().toLowerCase() : null;
      return { email };
    },
  };
}

/** Mount FIRST: nothing else (static files, API, CSRF, helmet) runs for a request that fails this. */
export function accessGate(verifier: AccessVerifier): RequestHandler {
  return (req, res, next) => {
    const token = req.get('cf-access-jwt-assertion');
    if (!token) { res.status(403).type('text/plain').send('Forbidden'); return; }
    verifier.verify(token).then(({ email }) => { res.locals.accessEmail = email; next(); }, () => { res.status(403).type('text/plain').send('Forbidden'); });
  };
}
