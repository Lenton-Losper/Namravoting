import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { withBase } from '../basePath';
import { api, navigation, resetCsrf, SESSION_EXPIRED_MESSAGE, type User } from '../api';
import { useAuth } from '../auth';
import { landingFor, safeNext as validateNext } from '../safeNext';
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
  if (authMode === 'email-demo') return <EmailSignIn />;
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
  useEffect(() => { if (user) nav(landingFor(safeNext, isAdmin), { replace: true }); }, [user, isAdmin, safeNext, nav]);
  if (user) return <Spinner label="Signing you in…" />;
  if (auto) return <main className="login-page"><div className="card card-accent login-card"><div className="login-brand"><Wordmark dark /></div><p className="note" role="status">{SESSION_EXPIRED_MESSAGE}</p><Spinner /></div></main>;
  const href = withBase(`/auth/login${safeNext ? `?next=${encodeURIComponent(safeNext)}` : ''}`);
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

/**
 * Demo (Cloudflare Access): never a button. Cloudflare Access has already checked the email code before this page could load, so the
 * identity is read again from the server (after a 401 the signed-in user was cleared) and the browser goes straight on to the safe
 * `next` path, or /admin for admins and /votes for everyone else. Only if Access really sent no identity is there a link: to the
 * Access sign-in, never to Microsoft.
 */
export const ACCESS_LOGIN = '/cdn-cgi/access/login';
function AccessSignIn() {
  const { user, isAdmin, refresh } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const safeNext = validateNext(params.get('next'));
  const [checked, setChecked] = useState(false);
  useEffect(() => { let alive = true; void refresh().finally(() => { if (alive) setChecked(true); }); return () => { alive = false; }; }, [refresh]);
  useEffect(() => { if (user) nav(landingFor(safeNext, isAdmin), { replace: true }); }, [user, isAdmin, safeNext, nav]);
  if (user || !checked) return <Spinner label="Signing you in…" />;
  return (
    <main className="login-page"><div className="card card-accent login-card">
      <div className="login-brand"><Wordmark dark /></div>
      <h1>Sign in</h1>
      <p className="note" role="status">Your Cloudflare Access sign-in was not found or has ended.</p>
      <a className="btn btn-primary" href={ACCESS_LOGIN}>Sign in with your email code</a>
    </div></main>
  );
}

/**
 * DEMO ONLY (AUTH_MODE=email-demo): one email field and a Sign in button, for everyone (admins included). No code, no password.
 */
function EmailSignIn() {
  const { user, isAdmin, refresh } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const safeNext = validateNext(params.get('next'));
  const expired = params.get('expired') === '1';
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (user) nav(landingFor(safeNext, isAdmin), { replace: true }); }, [user, isAdmin, safeNext, nav]);

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api<{ user: User }>('POST', '/api/email-login', { email });
      resetCsrf();                                  // the CSRF token is bound to the session: fetch a new one
      await refresh();
      nav(landingFor(safeNext, r.user.roles.includes('CampaignAdmin')), { replace: true });
    } catch (err) {
      setError((err as Error).message);
    } finally { setBusy(false); }
  }

  if (user) return <Spinner label="Signing you in…" />;
  return (
    <main className="login-page">
      <form className="card card-accent login-card stack" onSubmit={(e) => void submit(e)}>
        <div className="login-brand"><Wordmark dark /></div>
        <h1>Sign in</h1>
        {expired && <p className="note" role="status">Your session ended. Please sign in again.</p>}
        <label>Email address
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
            autoComplete="email" inputMode="email" required maxLength={254} placeholder="name@namra.org.na" />
        </label>
        <ErrorBox message={error} />
        <button className="btn btn-primary" disabled={busy || !email.trim()}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="muted small demo-note">Demo sign-in: no code is sent. Use your @namra.org.na email address.</p>
      </form>
    </main>
  );
}

/** DEV ONLY (AUTH_MODE=dev): pick a seeded identity. */
function DevPicker() {
  const [users, setUsers] = useState<User[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { refresh } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const safeNext = validateNext(params.get('next'));   // only relative /v/, /n/, /votes, /observe, /admin paths

  useEffect(() => {
    api<{ users: User[] }>('GET', '/api/dev/users').then((r) => setUsers(r.users)).catch(() => setError('Dev login is not available on this server.'));
  }, []);

  async function signIn(u: User) {
    setError(null);
    try {
      await api('POST', '/api/dev/login', u);
      resetCsrf();                                  // the CSRF token is bound to the session: fetch a new one
      await refresh();
      nav(landingFor(safeNext, u.roles.includes('CampaignAdmin')), { replace: true });
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
