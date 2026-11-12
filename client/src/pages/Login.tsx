import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, navigation, resetCsrf, SESSION_EXPIRED_MESSAGE, type User } from '../api';
import { useAuth } from '../auth';
import { safeNext as validateNext } from '../safeNext';
import { Wordmark } from '../icons';
import { ErrorBox, Spinner, initials } from '../ui';

/**
 * Demo: no screen at all. The Cloudflare Access login already identified the user (the server reads it from the verified
 * Access token), so /login just forwards to the safe `next` path. Dev: the identity picker below.
 */
export function LoginPage() {
  const { authMode, loading } = useAuth();
  if (loading) return <Spinner />;
  if (authMode === 'entra') return <MicrosoftSignIn />;
  return authMode === 'demo' ? <AccessSignIn /> : <DevPicker />;
}

/** Entra: one button. The server starts the Microsoft sign-in and brings the user straight back to `next`. */
function MicrosoftSignIn() {
  const { user, isAdmin } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const safeNext = validateNext(params.get('next'));
  const failed = params.get('error') === 'signin_failed';
  const expired = params.get('expired') === '1';
  const [auto, setAuto] = useState(false);
  const resumeHref = `/auth/login?resume=1${safeNext ? `&next=${encodeURIComponent(safeNext)}` : ''}`;
  // An expired session goes straight back to Microsoft (no account picker, so it usually signs in silently). If that already
  // happened a moment ago and we are back here again, stop and show the button instead of looping.
  useEffect(() => {
    if (!expired || user || failed) return;
    let last = 0;
    try { last = Number(sessionStorage.getItem('namra:reauth') ?? 0); } catch { /* storage unavailable */ }
    if (Date.now() - last < 60_000) return;
    try { sessionStorage.setItem('namra:reauth', String(Date.now())); } catch { /* storage unavailable */ }
    setAuto(true); navigation.replace(resumeHref);
  }, [expired, user, failed, resumeHref]);
  useEffect(() => { if (user) nav(safeNext ?? (isAdmin ? '/admin' : '/votes'), { replace: true }); }, [user, isAdmin, safeNext, nav]);
  if (user) return <Spinner label="Signing you in…" />;
  if (auto) return <main className="login-page"><div className="card card-accent login-card"><div className="login-brand"><Wordmark dark /></div><p className="note" role="status">{SESSION_EXPIRED_MESSAGE}</p><Spinner /></div></main>;
  const href = `/auth/login${safeNext ? `?next=${encodeURIComponent(safeNext)}` : ''}`;
  return (
    <main className="login-page">
      <div className="card card-accent login-card">
        <div className="login-brand"><Wordmark dark /></div>
        <h1>Sign in</h1>
        <p className="note">{expired && !failed ? 'Your session expired. Please sign in again.' : 'Use your NamRA Microsoft account.'}</p>
        <ErrorBox message={failed ? "We couldn't sign you in. Please try again." : null} />
        <a className="btn btn-primary" href={href}>Sign in with Microsoft</a>
      </div>
    </main>
  );
}

function AccessSignIn() {
  const { user, isAdmin, refresh } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const safeNext = validateNext(params.get('next'));
  useEffect(() => { if (user) nav(safeNext ?? (isAdmin ? '/admin' : '/votes'), { replace: true }); }, [user, isAdmin, safeNext, nav]);
  if (user) return <Spinner label="Signing you in…" />;
  return (
    <main className="login-page"><div className="card card-accent login-card">
      <ErrorBox message="We couldn't read your sign-in from Cloudflare Access." onRetry={() => void refresh()} />
    </div></main>
  );
}

/** DEV ONLY (AUTH_MODE=dev): pick a seeded identity. */
function DevPicker() {
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { refresh } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const safeNext = validateNext(params.get('next'));   // only relative /v/, /votes, /admin paths

  useEffect(() => {
    api<{ users: User[] }>('GET', '/api/dev/users').then((r) => setUsers(r.users)).catch(() => setError('Dev login is not available on this server.'));
  }, []);

  async function signIn(u: User) {
    setError(null);
    try {
      await api('POST', '/api/dev/login', u);
      resetCsrf();                                  // the CSRF token is bound to the session: fetch a new one
      await refresh();
      nav(safeNext ?? (u.roles.includes('CampaignAdmin') ? '/admin' : '/votes'), { replace: true });
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <main className="login-page">
      <div className="card card-accent login-card">
        <div className="login-brand"><Wordmark dark /></div>
        <h1>Sign in</h1>
        <p className="note">Development sign-in: choose a test identity. Microsoft Entra ID sign-in will replace this.</p>
        <ErrorBox message={error} />
        {!users && !error && <Spinner />}
        <ul className="list">
          {users?.map((u) => (
            <li key={u.oid}>
              <button className="user-row" onClick={() => void signIn(u)}>
                <span className="thumb thumb-sm thumb-empty" aria-hidden="true">{initials(u.displayName)}</span>
                <span className="user-row-text">
                  <strong>{u.displayName}</strong>
                  <span className="muted small">{u.email}</span>
                </span>
                {u.roles.includes('CampaignAdmin') && <span className="chip chip-outline">Campaign admin</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
