/**
 * SEC-18: every time the app shows or accepts is Windhoek time (Africa/Windhoek, CAT, UTC+2), whatever zone the browser or the
 * server runs in. Times are STORED as UTC instants (timestamptz) and the API speaks ISO 8601 with an offset; only this module
 * converts. Pure functions with no dependencies, so the server's unit tests can check them (tests/unit/windhoek.test.ts).
 */
export const TZ = 'Africa/Windhoek';
export const TZ_LABEL = 'CAT';

const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

function fields(ms: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const o: Record<string, number> = {};
  for (const p of parts.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return { y: o.year, mo: o.month, d: o.day, h: o.hour, mi: o.minute, s: o.second };
}

/** Offset of Windhoek time from UTC, in minutes, at the given instant (120 today). */
export function offsetMinutes(ms: number): number {
  const f = fields(ms);
  return Math.round((Date.UTC(f.y, f.mo - 1, f.d, f.h, f.mi, f.s) - Math.floor(ms / 1000) * 1000) / 60000);
}

/** "2026-11-12T09:30" typed in a datetime-local field, read as Windhoek time -> ISO 8601 UTC. null for empty or invalid. */
export function localInputToIso(v: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v ?? '');
  if (!m) return null;
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let guess = asUtc - offsetMinutes(asUtc) * 60000;
  guess = asUtc - offsetMinutes(guess) * 60000;          // second pass settles the offset around a zone change
  return new Date(guess).toISOString();
}

/** ISO instant -> the "YYYY-MM-DDTHH:mm" a datetime-local field shows, in Windhoek time. */
export function isoToLocalInput(iso: string | null): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const f = fields(ms); const p = (n: number) => String(n).padStart(2, '0');
  return `${f.y}-${p(f.mo)}-${p(f.d)}T${p(f.h)}:${p(f.mi)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "12 Nov 2026, 09:30 CAT". Always Windhoek time, always labelled. */
export function formatWindhoek(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const f = fields(ms); const p = (n: number) => String(n).padStart(2, '0');
  return `${f.d} ${MONTHS[f.mo - 1]} ${f.y}, ${p(f.h)}:${p(f.mi)} ${TZ_LABEL}`;
}
