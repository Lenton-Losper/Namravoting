import { isIP } from 'node:net';
import type { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { Config } from '../config.js';

/**
 * Throttles for the endpoints that have no signed-in user to key on (SEC-08).
 *
 * The limits are in memory and the app runs as ONE instance (worker/wrangler.jsonc max_instances: 1), so they reset on a
 * restart and would not be shared by a second instance. That is acceptable for these endpoints: a restart only gives an
 * attacker a fresh minute, and the limits protect cost (token calls to Microsoft) and noise, not a secret.
 *
 * Behind the Cloudflare Worker every request reaches the container from the same internal address, so the client address is
 * the one Cloudflare sets in CF-Connecting-IP (the edge overwrites any value a client sends). Without it (local, tests) the
 * socket address is used. A forged header can only move a caller into a different bucket, never past the limit.
 */
export function clientIp(req: Request): string {
  const cf = req.get('cf-connecting-ip')?.trim();
  return cf && isIP(cf) ? cf : (req.ip ?? '');
}

const byIp = (req: Request) => ipKeyGenerator(clientIp(req));

/** /auth/login, /auth/callback, /auth/logout: each callback makes an outbound token request to Microsoft. */
export const authLimiter = (config: Config) => rateLimit({
  windowMs: 60_000, limit: config.authRateLimit, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: byIp,
  message: 'Too many sign-in attempts. Wait a minute and try again.',
});

/** /api/csrf: anyone can mint a token; keep it cheap to ignore a flood. */
export const csrfLimiter = (config: Config) => rateLimit({
  windowMs: 60_000, limit: config.authRateLimit * 4, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: byIp,
  message: { error: 'Too many requests' },
});
