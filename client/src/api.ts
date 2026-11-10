export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

let csrf: string | null = null;
async function csrfToken(force = false): Promise<string> {
  if (!csrf || force) csrf = ((await (await fetch('/api/csrf', { credentials: 'same-origin' })).json()) as { token: string }).token;
  return csrf;
}

export async function api<T = unknown>(method: string, url: string, body?: unknown, retry = true): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  if (method !== 'GET') headers['X-CSRF-Token'] = await csrfToken();
  const res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' });
  if (res.status === 403 && method !== 'GET' && retry) {
    const j = await res.clone().json().catch(() => ({}));
    if ((j as { error?: string }).error === 'Invalid CSRF token') { await csrfToken(true); return api<T>(method, url, body, false); }
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? 'Something went wrong', (data as { code?: string }).code);
  return data as T;
}

export interface User { oid: string; email: string; displayName: string; roles: string[] }
export interface Candidate { id: string; name: string; bio: string | null; photo_url: string | null }
export interface Campaign {
  id: string; title: string; description: string | null; status: 'draft' | 'open' | 'closed';
  opens_at: string | null; closes_at: string | null; eligibility: 'all' | 'list' | 'umoja'; results_published: boolean;
  share_token: string; share_url: string; turnout?: number; eligible_count?: number | null;
}
export interface CampaignDetail extends Campaign { candidates: Candidate[]; eligible_emails: string[]; umoja_active_count: number }
export interface Results { status: string; results_published: boolean; candidates: { id: string; name: string; votes: number }[]; turnout: { votes: number; eligible: number | null } }

export interface SummaryCampaign {
  id: string; title: string; status: 'draft' | 'open' | 'closed'; created_at: string; opens_at: string | null; closes_at: string | null;
  started_at: string | null; closed_at: string | null; results_published: boolean; turnout: number; eligible_count: number | null;
}
export interface Winner { id: string; name: string; votes: number; tie: boolean; photo_url: string | null }
export interface Summary {
  counts: { active: number; drafts: number; votes_open: number };
  open: SummaryCampaign[]; featured: SummaryCampaign | null;
  closed: (SummaryCampaign & { winner: Winner | null })[];
}

export const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const toLocalInput = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso); const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : null);
