import { safeNext } from './safeNext';
import { formatWindhoek, isoToLocalInput, localInputToIso } from './windhoek';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}

/** Page navigation, as an object so tests can observe it. */
export const navigation = { assign: (u: string) => window.location.assign(u), replace: (u: string) => window.location.replace(u) };
export const SESSION_EXPIRED_MESSAGE = 'Your session expired, signing you back in…';

let expiredHandler: (() => void) | null = null;
let redirecting = false;
/** The auth provider registers here so a 401 from ANY call clears the signed-in user. Returns an unsubscribe. */
export function onSessionExpired(fn: () => void): () => void { expiredHandler = fn; return () => { if (expiredHandler === fn) expiredHandler = null; }; }
export const resetSessionExpiredGuard = () => { redirecting = false; };
/** Any 401 means the session is gone: forget the user, then go to /login?next=<where we are>, which goes straight to Microsoft. */
function sessionExpired() {
  if (redirecting) return;                      // several calls can fail at once: one redirect
  const here = window.location.pathname + window.location.search;
  if (window.location.pathname.startsWith('/login')) return;
  redirecting = true;
  resetCsrf(); expiredHandler?.();
  const next = safeNext(here);
  navigation.assign('/login?expired=1' + (next ? `&next=${encodeURIComponent(next)}` : ''));
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
  if (res.status === 401 && !url.startsWith('/api/dev/')) { sessionExpired(); throw new ApiError(401, SESSION_EXPIRED_MESSAGE); }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as { error?: string }).error ?? (res.status >= 500 ? 'The service is starting up or temporarily unavailable. Please retry.' : 'Something went wrong'), (data as { code?: string }).code);
  return data as T;
}

export interface User { oid: string; email: string; displayName: string; roles: string[] }
export interface Candidate {
  id: string; name: string; bio: string | null; photo_url: string | null; withdrawn_at?: string | null; withdrawn_reason?: string | null;
  position_id?: string; region_id?: string | null; region?: string | null; status?: CandidateStatus; self_nominated?: boolean; submitted_at?: string | null; review_reason?: string | null;
}
/** invited / submitted (waiting for the admin) / approved (on the ballot) / rejected / withdrawn (the candidate stood down before the start). */
export type CandidateStatus = 'invited' | 'submitted' | 'approved' | 'rejected' | 'withdrawn';
export interface Region { id: string; name: string; sort_order?: number; candidates?: number }
export type NominationState = 'not_invited' | 'open' | 'closed' | 'expired' | 'ended';
/** One block on the campaign page: a position with its candidate counts and nomination status (and, once closed, its outcome). */
export interface Position {
  id: string; title: string; description: string | null; sort_order: number; seats: number; min_candidates: number | null; max_candidates: number | null;
  status: 'open' | 'closed'; nomination_state: NominationState; invite_url: string | null; required: number;
  counts: { approved: number; submitted: number; rejected: number; withdrawn: number; invited: number };
  result: { turnout: number; winners: string[]; tie: string[] | null } | null;
}
export interface Nomination { id: string; name: string; bio: string | null; photo_url: string | null; status: CandidateStatus; region_id: string | null; region: string | null; submitted_at: string | null; submitted_by: string | null; submitted_by_email: string | null; review_reason: string | null }
export interface Campaign {
  id: string; title: string; description: string | null; status: 'draft' | 'open' | 'closed';
  opens_at: string | null; closes_at: string | null; eligibility: 'all' | 'list' | 'umoja'; results_published: boolean;
  share_token: string; share_url: string; turnout?: number; eligible_count?: number | null; archived_at?: string | null;
  /** Title, description, closing time (and candidates until the first vote) stay editable after the campaign starts. */
  allow_edits_after_start?: boolean;
  /** An "Abstain (none of the above)" line is on the ballot (set while a draft, locked at start). */
  allow_abstain?: boolean;
  /** Resets and permanent deletes need a co-admin's approval (switched on, never off). */
  require_approval?: boolean;
  /** Your role on this campaign: its creator, or a co-admin (can run it, not reset/delete/archive or change the team). */
  my_role?: 'owner' | 'co_admin';
  /** The retention job removed receipts, voter lists and photos on this date; the sealed result remains. */
  receipts_purged_at?: string | null;
  /** Minimum turnout (percent of eligible voters); a result below it is flagged. Set while a draft. */
  quorum_percent?: number | null;
  /** When the closed result is published automatically (set by the creator or a co-admin). */
  publish_at?: string | null;
}
export interface IntegrityBlock { ballots: number; receipts: number; at: string }
export interface CampaignDetail extends Campaign { positions?: Position[]; regions?: Region[]; nominations_close_at?: string | null; nominate_eligibility?: 'all' | 'umoja' | null; results_group_by_region?: boolean; turnout: number; candidates: Candidate[]; eligible_emails: string[]; umoja_active_count: number; integrity_block?: IntegrityBlock | null; edited_after_start?: Notice[] }
/** A reset or an early close, with the reason the creator gave. Shown to voters (SEC-01). */
export interface EditChange { what: 'title' | 'description' | 'closes_at' | 'candidate_added' | 'candidate_edited' | 'candidate_removed' | 'position_title' | 'position_description'; name?: string; from?: string | null; to?: string | null }
export interface Notice { kind: 'reset' | 'closed_early' | 'edited_after_start' | 'candidate_withdrawn'; candidate?: string; at: string; by: string | null; reason: string; votes_cleared?: number; candidates?: { name: string; votes: number; position?: string }[]; changes?: EditChange[] }
export interface ResetEntry extends Notice { votes_cleared: number }
/** `candidates` is null while the campaign is open: per-candidate counts exist only after it has closed (SEC-01). */
/** Run-off context of a closed campaign (creator only). */
export interface RunoffInfo { round: number; max: number; next: { id: string; title: string; status: string } | null; parent: { id: string; title: string } | null; can_start: boolean }
export interface Tie { names: string[]; votes: number }
export interface Quorum { percent: number; eligible: number | null; needed: number | null; votes: number; met: boolean | null }
export interface Publication { by: string | null; at: string; scheduled: boolean }
export interface ResultCandidate { id: string; name: string; votes: number; is_abstain?: boolean; withdrawn?: boolean; region?: string | null; position_id?: string }
/** One position's result. While the campaign is open `candidates` is null: only the turnout of the position is shown. */
export interface PositionResult { id: string; title: string; description?: string | null; candidates: ResultCandidate[] | null; turnout: { votes: number; eligible?: number | null }; winners?: { id: string; name: string; votes: number }[]; tie?: Tie | null }
export interface Results { status: string; results_published: boolean; archived?: boolean; positions?: PositionResult[]; group_by_region?: boolean; candidates: ResultCandidate[] | null; turnout: { votes: number; eligible: number | null }; resets?: ResetEntry[]; notices?: Notice[]; tie?: Tie | null; runoff?: RunoffInfo; quorum?: Quorum | null; publication?: Publication | null }
export interface SealCheck {
  chain_ok: boolean; chain_checked: number; sealed: boolean; sealed_at: string | null; seal_hash: string | null; seal_seq: number | null;
  tallies_match: boolean | null; receipts_match: boolean | null; sealed_tallies: { name: string; votes: number }[]; sealed_turnout: number | null;
  positions?: { position_id: string; title: string; fingerprint: string; tallies_match: boolean | null; receipts_match: boolean | null }[];
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
