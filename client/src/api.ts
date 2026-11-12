import { formatWindhoek, isoToLocalInput, localInputToIso } from './windhoek';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

let csrf: string | null = null;
/** Forget the cached CSRF token: it is bound to the session, so sign-in and sign-out make it stale (SEC-15). */
export const resetCsrf = () => { csrf = null; };
async function csrfToken(force = false): Promise<string> {
  if (!csrf || force) csrf = ((await (await fetch('/api/csrf', { credentials: 'same-origin' })).json()) as { token: string }).token;
  return csrf;
}

const RETRIES = 6;
const RETRY_DELAY_MS = 4000;

export async function api<T = unknown>(method: string, url: string, body?: unknown, retry = true): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  if (method !== 'GET') headers['X-CSRF-Token'] = await csrfToken();
  let res = await fetch(url, { method, headers, body: payload, credentials: 'same-origin' }).catch(() => null);
  // Cold start / rollout: the gateway answers 502-504 while the app container comes up. Retry reads quietly.
  for (let n = 0; method === 'GET' && (!res || [502, 503, 504].includes(res.status)) && n < RETRIES; n++) {
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    res = await fetch(url, { method, headers, credentials: 'same-origin' }).catch(() => null);
  }
  if (!res) throw new ApiError(0, "Can't reach the server. Check your connection and retry.");
  if (res.status === 403 && method !== 'GET' && retry) {
    const j = await res.clone().json().catch(() => ({}));
    if ((j as { error?: string }).error === 'Invalid CSRF token') { await csrfToken(true); return api<T>(method, url, body, false); }
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? (res.status >= 500 ? 'The service is starting up or temporarily unavailable. Please retry.' : 'Something went wrong'), (data as { code?: string }).code);
  return data as T;
}

export interface User { oid: string; email: string; displayName: string; roles: string[] }
export interface Candidate { id: string; name: string; bio: string | null; photo_url: string | null }
export interface Campaign {
  id: string; title: string; description: string | null; status: 'draft' | 'open' | 'closed';
  opens_at: string | null; closes_at: string | null; eligibility: 'all' | 'list' | 'umoja'; results_published: boolean;
  share_token: string; share_url: string; turnout?: number; eligible_count?: number | null; archived_at?: string | null;
}
export interface IntegrityBlock { ballots: number; receipts: number; at: string }
export interface CampaignDetail extends Campaign { turnout: number; candidates: Candidate[]; eligible_emails: string[]; umoja_active_count: number; integrity_block?: IntegrityBlock | null }
/** A reset or an early close, with the reason the creator gave. Shown to voters (SEC-01). */
export interface Notice { kind: 'reset' | 'closed_early'; at: string; by: string | null; reason: string; votes_cleared?: number; candidates?: { name: string; votes: number }[] }
export interface ResetEntry extends Notice { votes_cleared: number }
/** `candidates` is null while the campaign is open: per-candidate counts exist only after it has closed (SEC-01). */
export interface Results { status: string; results_published: boolean; archived?: boolean; candidates: { id: string; name: string; votes: number }[] | null; turnout: { votes: number; eligible: number | null }; resets?: ResetEntry[]; notices?: Notice[] }
export interface SealCheck {
  chain_ok: boolean; chain_checked: number; sealed: boolean; sealed_at: string | null; seal_hash: string | null; seal_seq: number | null;
  tallies_match: boolean | null; receipts_match: boolean | null; sealed_tallies: { name: string; votes: number }[]; sealed_turnout: number | null;
}

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

// All times are Windhoek time (CAT, UTC+2), whatever the browser's zone is (SEC-18). See windhoek.ts.
export const fmtDate = (iso: string | null) => formatWindhoek(iso);
export const toLocalInput = (iso: string | null) => isoToLocalInput(iso);
export const fromLocalInput = (v: string) => localInputToIso(v);
