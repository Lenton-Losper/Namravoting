// Expired sessions: any 401 clears the user and goes to /login?next=…, which goes straight back to Microsoft (no loop);
// a vote in progress keeps its selection through the re-sign-in.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api, ApiError, navigation, onSessionExpired, resetCsrf, resetSessionExpiredGuard } from './api';
import { AuthProvider } from './auth';
import { LoginPage } from './pages/Login';
import { MyVotes } from './pages/MyVotes';
import { VotePage } from './pages/Vote';

const TOKEN = 'a'.repeat(32);
type Handler = (method: string, url: string) => { status?: number; body?: unknown };
let handler: Handler;
let calls: { method: string; url: string }[];
let assign: ReturnType<typeof vi.fn>; let replace: ReturnType<typeof vi.fn>;

beforeEach(() => {
  calls = []; resetCsrf(); resetSessionExpiredGuard(); sessionStorage.clear();
  assign = vi.fn(); replace = vi.fn();
  vi.spyOn(navigation, 'assign').mockImplementation(assign as never);
  vi.spyOn(navigation, 'replace').mockImplementation(replace as never);
  handler = () => ({ body: {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    const h = url === '/api/csrf' ? { body: { token: 't' } } : handler(method, url);
    return new Response(JSON.stringify(h.body ?? {}), { status: h.status ?? 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

const gone = { status: 401, body: { error: 'Not signed in' } };

describe('a 401 from any call', () => {
  it('clears the user and goes to /login?next=<current path>', async () => {
    window.history.pushState({}, '', '/admin/c/abc?tab=results');
    handler = () => gone;
    const cleared = vi.fn(); onSessionExpired(cleared);
    await expect(api('GET', '/api/campaigns/mine')).rejects.toMatchObject({ status: 401 });
    expect(cleared).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith('/login?expired=1&next=' + encodeURIComponent('/admin/c/abc?tab=results'));
  });

  it('works for writes too, and several failing calls cause one redirect', async () => {
    window.history.pushState({}, '', '/votes');
    handler = () => gone;
    await Promise.allSettled([api('GET', '/api/vote'), api('POST', '/api/x', {}), api('GET', '/api/y')]);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it('shows the session-expired message, not "Not signed in" with Retry', async () => {
    window.history.pushState({}, '', '/votes');
    handler = () => gone;
    render(<MemoryRouter><AuthProvider><MyVotes /></AuthProvider></MemoryRouter>);
    expect(await screen.findAllByText(/Your session expired, signing you back in/)).not.toHaveLength(0);
    expect(screen.queryByText('Not signed in')).toBeNull();
    expect(assign).toHaveBeenCalled();
  });

  it('does not redirect when already on /login (no loop)', async () => {
    window.history.pushState({}, '', '/login?expired=1');
    handler = () => gone;
    await expect(api('GET', '/api/vote')).rejects.toBeInstanceOf(ApiError);
    expect(assign).not.toHaveBeenCalled();
  });

  it('a next path outside the allowed ones is dropped (open-redirect safe)', async () => {
    window.history.pushState({}, '', '/somewhere/else');
    handler = () => gone;
    await api('GET', '/api/vote').catch(() => undefined);
    expect(assign).toHaveBeenCalledWith('/login?expired=1');
  });
});

function renderLogin(search: string) {
  handler = (_m, url) => (url === '/api/session' ? { body: { user: null, authMode: 'entra' } } : {});
  return render(<MemoryRouter initialEntries={[`/login${search}`]}><AuthProvider><Routes><Route path="/login" element={<LoginPage />} /></Routes></AuthProvider></MemoryRouter>);
}

describe('/login after an expired session', () => {
  it('goes straight to Microsoft without the account picker, shows the message, and keeps next', async () => {
    renderLogin('?expired=1&next=%2Fv%2Fabc');
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/auth/login?resume=1&next=' + encodeURIComponent('/v/abc')));
    expect(await screen.findByText(/Your session expired, signing you back in/)).toBeTruthy();
    expect(replace.mock.calls[0][0]).not.toContain('select_account');
  });

  it('does not loop: if it just tried a moment ago, it shows the button instead', async () => {
    sessionStorage.setItem('namra:reauth', String(Date.now()));
    renderLogin('?expired=1&next=%2Fvotes');
    expect(await screen.findByRole('link', { name: 'Sign in with Microsoft' })).toBeTruthy();
    expect(screen.getByText('Your session expired. Please sign in again.')).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it('a plain visit to /login (not expired) still shows the button and does not redirect', async () => {
    renderLogin('');
    expect(await screen.findByRole('link', { name: 'Sign in with Microsoft' })).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('a vote in progress is never lost to an expired session', () => {
  const info = {
    title: 'Pick one', description: null, opensAt: null, closesAt: null, resultsPublished: false, voterState: 'can_vote', notices: [],
    candidates: [{ id: 'c1', name: 'Ann', bio: null, photoUrl: null }, { id: 'c2', name: 'Ben', bio: null, photoUrl: null }],
  };
  const ballot = () => render(<MemoryRouter initialEntries={[`/v/${TOKEN}`]}><Routes><Route path="/v/:shareToken" element={<VotePage />} /></Routes></MemoryRouter>);

  it('401 on the vote POST: re-authenticate, come back to the ballot with the selection kept (not auto-submitted)', async () => {
    window.history.pushState({}, '', `/v/${TOKEN}`);
    handler = (m, url) => (m === 'POST' ? gone : url === `/api/vote/${TOKEN}` ? { body: info } : {});
    const user = userEvent.setup();
    ballot();
    await user.click(await screen.findByRole('radio', { name: /Ben/ }));
    await user.click(screen.getByRole('button', { name: 'Cast vote' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm vote' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/login?expired=1&next=' + encodeURIComponent(`/v/${TOKEN}`)));
    cleanup();

    // the person signs in again and the ballot loads fresh
    resetSessionExpiredGuard(); calls = [];
    handler = (_m, url) => (url === `/api/vote/${TOKEN}` ? { body: info } : {});
    ballot();
    const ben = await screen.findByRole('radio', { name: /Ben/ });
    await waitFor(() => expect(ben.getAttribute('aria-checked')).toBe('true'));
    expect(calls.some((c) => c.method === 'POST')).toBe(false);                    // nothing is sent on its own
    expect(sessionStorage.getItem(`namra:pending-vote:${TOKEN}`)).toBeNull();      // used once, then gone
  });

  it('any other outcome of the vote POST does not leave the choice behind', async () => {
    handler = (m, url) => (m === 'POST' ? { status: 409, body: { error: 'closed' } } : url === `/api/vote/${TOKEN}` ? { body: info } : {});
    const user = userEvent.setup();
    ballot();
    await user.click(await screen.findByRole('radio', { name: /Ann/ }));
    await user.click(screen.getByRole('button', { name: 'Cast vote' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm vote' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    await waitFor(() => expect(sessionStorage.getItem(`namra:pending-vote:${TOKEN}`)).toBeNull());
    expect(assign).not.toHaveBeenCalled();
  });
});
