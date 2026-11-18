import crypto from 'node:crypto';

export interface EligibilityRule { eligibility: 'all' | 'list' | 'umoja' }

export const normalizeEmail = (e: string): string => e.trim().toLowerCase();

/** Splits pasted text (commas, semicolons, whitespace, newlines) into unique, lowercased, valid emails. */
export function parseEmailList(raw: string): { emails: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const invalid: string[] = [];
  for (const tok of raw.split(/[\s,;]+/).map(normalizeEmail).filter(Boolean)) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tok) || tok.length > 254) invalid.push(tok);
    else seen.add(tok);
  }
  return { emails: [...seen], invalid };
}

/** The mail domain of NamRA staff. A listed address outside it is allowed (a guest, a consultant) but is flagged, because it is usually a typo. */
export const NAMRA_DOMAIN = 'namra.org.na';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isEmailAddress = (e: string): boolean => EMAIL_RE.test(e) && e.length <= 254;

/**
 * Checks a pasted or submitted list WITHOUT rejecting it: `emails` are the valid, de-duplicated, lower-cased addresses that will be saved;
 * `invalid` are the entries that are not an email address at all (not saved; named exactly so the admin can fix them); `notNamra` are
 * valid addresses that do not end in @namra.org.na (saved, but flagged).
 */
export function checkEmailList(raw: string[]): { emails: string[]; invalid: string[]; notNamra: string[] } {
  const seen = new Set<string>(); const invalid: string[] = []; const badInvalid = new Set<string>();
  for (const tok of raw.map(normalizeEmail).filter(Boolean)) {
    if (!isEmailAddress(tok)) { if (!badInvalid.has(tok)) { badInvalid.add(tok); invalid.push(tok); } } else seen.add(tok);
  }
  const emails = [...seen];
  return { emails, invalid, notNamra: emails.filter((e) => !e.endsWith('@' + NAMRA_DOMAIN)) };
}

/** SHA-256 (hex) of a voter list: the lower-case addresses, de-duplicated, sorted byte-wise, joined by line feeds. The database computes the same (eligible_list_sha256). */
export function eligibleListHash(emails: string[]): string {
  const sorted = [...new Set(emails.map(normalizeEmail))].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return crypto.createHash('sha256').update(sorted.join('\n'), 'utf8').digest('hex');
}

export function isEligible(rule: EligibilityRule, email: string, list: Set<string>): boolean {
  if (rule.eligibility === 'umoja') return false;   // decided by the DB membership check, never by an email list
  return rule.eligibility === 'all' || list.has(normalizeEmail(email));
}
