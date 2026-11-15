/**
 * Post-login redirect target validation (server copy of client/src/safeNext.ts; a test keeps them identical).
 * Accepts only same-site RELATIVE paths under /v/ (a ballot), /n/ (a nomination link), /votes, /observe or /admin. Anything else returns
 * null so the caller falls back to the default page (open-redirect protection).
 */
const ALLOWED = /^\/(?:v\/|n\/|votes(?:[/?#]|$)|admin(?:[/?#]|$)|observe(?:[/?#]|$))/;

export function safeNext(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return null;
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;       // also rejects absolute URLs and schemes
  if (raw.includes('\\')) return null;                                  // "/\evil.com" is treated as "//evil.com" by browsers
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\s]/.test(raw)) return null;                 // control chars / whitespace tricks
  if (!ALLOWED.test(raw)) return null;
  try {
    const u = new URL(raw, 'http://placeholder.invalid');
    if (u.origin !== 'http://placeholder.invalid') return null;
  } catch { return null; }
  return raw;
}

/**
 * Where a person goes right after signing in: the safe `next` page they came from, otherwise the default for their role (/admin for
 * campaign admins, /votes for everyone else). An /admin page is never the destination for someone who is not an admin: they would only
 * see "Not allowed", so they go to /votes instead. A ballot (/v/) or nomination link (/n/) always comes back to that exact page.
 */
export function landingFor(rawNext: string | null | undefined, isAdmin: boolean): string {
  const next = safeNext(rawNext);
  if (next && !isAdmin && /^\/admin(?:[/?#]|$)/.test(next)) return '/votes';
  return next ?? (isAdmin ? '/admin' : '/votes');
}
