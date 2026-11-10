export interface EligibilityRule { eligibility: 'all' | 'list' }

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

export function isEligible(rule: EligibilityRule, email: string, list: Set<string>): boolean {
  return rule.eligibility === 'all' || list.has(normalizeEmail(email));
}
