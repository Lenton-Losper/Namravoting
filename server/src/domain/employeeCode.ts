/** NamRA employee codes are three letters + four digits (e.g. NAM0000 or EXE0000). */
export const EMPLOYEE_CODE_RE = /^[A-Z]{3}\d{4}$/;

/** Trim + upper-case. Returns the code only if it is well-formed, otherwise null. */
export function normalizeEmployeeCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const c = raw.replace(/^\uFEFF/, '').trim().toUpperCase();
  return EMPLOYEE_CODE_RE.test(c) ? c : null;
}
