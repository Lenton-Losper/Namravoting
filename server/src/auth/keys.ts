import crypto from 'node:crypto';
import type { Config } from '../config.js';
import type { Key } from './signing.js';

/**
 * SEC-06: separate signing keys per purpose, so a signed value of one kind can never be presented as another (a sign-in-flow
 * cookie as a session, a CSRF token as anything), and so the CSRF key can be rotated on its own.
 *
 * Each key is HKDF-SHA256(secret, info = "namra:v1:<purpose>"). The secret is SESSION_SECRET, except for CSRF where an
 * optional CSRF_SECRET takes over (rotate it without touching sessions). SESSION_SECRET_PREVIOUS is accepted for verification
 * only, so a rotation of SESSION_SECRET does not have to sign everyone out at the same moment.
 */
export type Purpose = 'session' | 'authflow' | 'csrf';

const derive = (secret: string, purpose: Purpose): Buffer =>
  Buffer.from(crypto.hkdfSync('sha256', secret, 'namra', `namra:v1:${purpose}`, 32));

/** Key used to SIGN new values. */
export function signingKey(config: Config, purpose: Purpose): Key {
  return derive(purpose === 'csrf' && config.csrfSecret ? config.csrfSecret : config.sessionSecret, purpose);
}

/** Keys accepted when VERIFYING: the current one first, then the previous one if configured. */
export function verifyKeys(config: Config, purpose: Purpose): Key[] {
  const keys = [signingKey(config, purpose)];
  if (purpose !== 'csrf' && config.sessionSecretPrevious) keys.push(derive(config.sessionSecretPrevious, purpose));
  return keys;
}
