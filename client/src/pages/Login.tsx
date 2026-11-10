import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, type User } from '../api';
import { useAuth } from '../auth';
import { safeNext as validateNext } from '../safeNext';
import { Wordmark } from '../icons';
import { ErrorBox, Spinner, initials } from '../ui';

/** DEV ONLY: pick a seeded identity. Replaced by Entra ID sign-in later. */
export function LoginPage() {
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
