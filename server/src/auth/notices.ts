import type { Config } from '../config.js';

/** How long before the Entra client secret expires the warning starts (days). */
export const SECRET_WARN_DAYS = 30;

export type AdminNotice =
  | { kind: 'demo_override' }
  | { kind: 'admin_by_email' }
  | { kind: 'secret_expiry'; daysLeft: number; expired: boolean };

const DAY = 24 * 3600 * 1000;

/** Whole days until the client secret expires (negative once expired); null when ENTRA_SECRET_EXPIRES_AT is not set. */
export function secretDaysLeft(config: Config, now: Date = new Date()): number | null {
  const at = config.entra?.secretExpiresAt;
  return at ? Math.floor((at.getTime() - now.getTime()) / DAY) : null;
}

/**
 * Banners for CAMPAIGN ADMINS only (returned by /api/session):
 *  - the demo membership override (DEMO_MEMBER_EMAILS) is active: some people count as Umoja members regardless of the HR list;
 *  - admins are matched by email instead of account id;
 *  - the Entra client secret expires within SECRET_WARN_DAYS days (or already has).
 */
export function adminNotices(config: Config, now: Date = new Date()): AdminNotice[] {
  const out: AdminNotice[] = [];
  const e = config.entra;
  if (!e) return out;
  if (e.demoMemberEmails.length > 0) out.push({ kind: 'demo_override' });
  if (e.adminOids.length === 0 && e.adminEmails.length > 0) out.push({ kind: 'admin_by_email' });
  const left = secretDaysLeft(config, now);
  if (left !== null && left <= SECRET_WARN_DAYS) out.push({ kind: 'secret_expiry', daysLeft: Math.max(left, 0), expired: left < 0 });
  return out;
}

/** Lines for the server log at start-up and once a day: the same conditions as the banners, for people who read logs. */
export function operatorWarnings(config: Config, now: Date = new Date()): { level: 'warn' | 'error'; line: string }[] {
  const out: { level: 'warn' | 'error'; line: string }[] = [];
  const e = config.entra;
  if (!e) return out;
  if (e.demoMemberEmails.length > 0) out.push({ level: 'warn', line: `[config] DEMO_MEMBER_EMAILS is active (${e.demoMemberEmails.length} address${e.demoMemberEmails.length === 1 ? '' : 'es'}): those users count as Umoja members regardless of the HR list. Remove it before a real election.` });
  if (e.adminOids.length === 0 && e.adminEmails.length > 0) out.push({ level: 'warn', line: '[config] admins are matched by email (ADMIN_EMAILS). Set ADMIN_OIDS to the admins\' Entra object ids; an email can be renamed or reused.' });
  if (e.adminOids.length > 0 && e.adminEmails.length > 0 && !e.adminEmailsAllowed) out.push({ level: 'warn', line: '[config] ADMIN_EMAILS is ignored because ADMIN_OIDS is set (set ADMIN_EMAILS_FALLBACK=true to use both).' });
  const left = secretDaysLeft(config, now);
  if (left === null) out.push({ level: 'warn', line: '[config] ENTRA_SECRET_EXPIRES_AT is not set: nothing will warn you before the Entra client secret expires and sign-in stops working.' });
  else if (left < 0) out.push({ level: 'error', line: `[config] the Entra client secret EXPIRED ${-left} day${left === -1 ? '' : 's'} ago (ENTRA_SECRET_EXPIRES_AT). Sign-in is failing: create a new secret and update ENTRA_CLIENT_SECRET.` });
  else if (left <= SECRET_WARN_DAYS) out.push({ level: 'warn', line: `[config] the Entra client secret expires in ${left} day${left === 1 ? '' : 's'}. Create a new one and update ENTRA_CLIENT_SECRET and ENTRA_SECRET_EXPIRES_AT.` });
  return out;
}

export function logOperatorWarnings(config: Config, now: Date = new Date()): void {
  for (const w of operatorWarnings(config, now)) (w.level === 'error' ? console.error : console.warn)(w.line);
}
