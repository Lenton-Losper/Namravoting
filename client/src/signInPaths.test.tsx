// Every entry point of the audit (docs/audit-auth-flow.md), end to end in the real router: a signed-out person opens a page, is sent to
// /login with the page as `next`, signs in on the email-demo page, and lands on the right page for their role.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { api, navigation, resetCsrf, resetSessionExpiredGuard } from './api';
import { App } from './App';
import { AuthProvider } from './auth';

const ADMIN = { oid: 'o1', email: 'lenton.losper@namra.org.na', displayName: 'Lenton Losper', roles: ['CampaignAdmin'], employeeCode: 'TST0026' };
const STAFF = { oid: 's1', email: 'sam@namra.org.na', displayName: 'Sam Staff', roles: [], employeeCode: null };
const VOTE = '/v/' + 'V'.repeat(32);
const NOMINATE = '/n/' + 'N'.repeat(32);
const ID = '50a77f0b-87bd-4f3f-b4fb-6833a94a1086';

let signedIn: typeof ADMIN | typeof STAFF | null;
let who: typeof ADMIN | typeof STAFF;
beforeEach(() => {
  signedIn = null; resetCsrf(); resetSessionExpiredGuard(); sessionStorage.clear();
  vi.spyOn(navigation, 'assign').mockImplementation(() => undefined);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === '/api/csrf') return json(200, { token: 't' });
    if (url === '/api/session') return json(200, { user: signedIn, authMode: 'email-demo', observing: 0, notices: [] });
    if (url === '/api/email-login' && init?.method === 'POST') { signedIn = who; return json(200, { user: who }); }
    return json(404, { error: 'Not found' });   // the page itself: an error card is fine here, only WHERE we land matters
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

function Where() { const l = useLocation(); return <output data-testid="where">{l.pathname + l.search}</output>; }
const open = (path: string) => render(<MemoryRouter initialEntries={[path]}><AuthProvider><App /><Where /></AuthProvider></MemoryRouter>);
const where = () => screen.getByTestId('where').textContent;

async function signInFrom(path: string, user: typeof ADMIN | typeof STAFF) {
  who = user;
  open(path);
  const email = await screen.findByLabelText('Email address');   // the guard sent the signed-out person to the sign-in page
  await userEvent.setup().type(email, user.email);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('signed out -> sign in -> the right page, per entry point and role', () => {
  // [entry point, admin lands on, non-admin lands on]
  const table: [string, string, string][] = [
    [VOTE, VOTE, VOTE],                                         // a ballot link always comes back to the ballot
    [NOMINATE, NOMINATE, NOMINATE],                             // a nomination link always comes back to it: never /admin or /votes
    ['/votes', '/votes', '/votes'],
    ['/observe', '/observe', '/observe'],
    [`/admin/c/${ID}?tab=results`, `/admin/c/${ID}?tab=results`, '/votes'],   // a non-admin is never sent to an admin page
    ['/admin', '/admin', '/votes'],
    ['/', '/admin', '/votes'],                                  // Home: the role default
    ['/login', '/admin', '/votes'],                             // the sign-in page opened directly: the role default
    ['/login?next=https%3A%2F%2Fevil.example%2Fn%2Fx', '/admin', '/votes'],   // an outside address is never followed
    ['/login?next=%2F%2Fevil.example', '/admin', '/votes'],
  ];
  for (const [entry, adminLands, staffLands] of table) {
    it(`${entry}: an admin lands on ${adminLands}`, async () => {
      await signInFrom(entry, ADMIN);
      await waitFor(() => expect(where()).toBe(adminLands));
    });
    it(`${entry}: a non-admin lands on ${staffLands}`, async () => {
      await signInFrom(entry, STAFF);
      await waitFor(() => expect(where()).toBe(staffLands));
    });
  }

  it('the guard keeps the full page in `next` (path and query) on the way to the sign-in page', async () => {
    open(`/admin/c/${ID}?tab=results`);
    await screen.findByLabelText('Email address');
    expect(where()).toBe(`/login?next=${encodeURIComponent(`/admin/c/${ID}?tab=results`)}`);
    cleanup();
    open(NOMINATE);
    await screen.findByLabelText('Email address');
    expect(where()).toBe(`/login?next=${encodeURIComponent(NOMINATE)}`);
  });

  it('a signed-in non-admin who opens an admin page directly sees "Not allowed" with a way to My votes (no admin data is fetched)', async () => {
    signedIn = STAFF;
    open('/admin');
    expect(await screen.findByRole('heading', { name: 'Not allowed' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to My votes' }).getAttribute('href')).toBe('/votes');
    const urls = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map((c) => c[0]);
    expect(urls.some((u) => u.startsWith('/api/campaigns'))).toBe(false);
  });

  it('someone already signed in who opens /login?next=<nomination link> goes straight there', async () => {
    signedIn = STAFF;
    open(`/login?next=${encodeURIComponent(NOMINATE)}`);
    await waitFor(() => expect(where()).toBe(NOMINATE));
  });
});

describe('a 401 (session ended) sends the person to sign in and back to the same page', () => {
  it.each([[NOMINATE], [VOTE], ['/votes'], [`/admin/c/${ID}`]])('from %s', async (page) => {
    window.history.pushState({}, '', page);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/csrf' ? { token: 't' } : { error: 'Not signed in' }), { status: url === '/api/csrf' ? 200 : 401, headers: { 'content-type': 'application/json' } })));
    await expect(api('GET', '/api/anything')).rejects.toThrow();
    expect(navigation.assign).toHaveBeenCalledWith(`/login?expired=1&next=${encodeURIComponent(page)}`);
  });
});

describe('signing out', () => {
  it('starts the next person on a clean /login, not on the page the previous person was on', async () => {
    signedIn = STAFF;
    open(NOMINATE);
    await screen.findAllByRole('button', { name: /Sign out/ });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(url === '/api/logout' ? null : JSON.stringify({ token: 't' }), { status: url === '/api/logout' ? 204 : 200, headers: { 'content-type': 'application/json' } })));
    await userEvent.setup().click(screen.getAllByRole('button', { name: /Sign out/ })[0]);
    await waitFor(() => expect(navigation.assign).toHaveBeenCalledWith('/login'));
  });
});
