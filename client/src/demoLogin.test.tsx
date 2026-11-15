// Demo mode (Cloudflare Access): /login never shows a button when Access has identified the person; it forwards straight in.
// A 401 does the same automatically. Only a genuinely missing Access identity shows a link, to the Access sign-in, never to Microsoft.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { api, navigation, resetCsrf, resetSessionExpiredGuard } from './api';
import { AuthProvider } from './auth';
import { LoginPage } from './pages/Login';

const ADMIN = { oid: 'o1', email: 'lenton.losper@namra.org.na', displayName: 'Lenton Losper', roles: ['CampaignAdmin'], employeeCode: 'TST0026' };
const STAFF = { oid: 's1', email: 'staff@namra.org.na', displayName: 'Sam Staff', roles: [], employeeCode: null };

let sessions: unknown[];   // successive answers of GET /api/session
let calls: string[];
let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  calls = []; resetCsrf(); resetSessionExpiredGuard(); sessionStorage.clear();
  assign = vi.fn();
  vi.spyOn(navigation, 'assign').mockImplementation(assign as never);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/api/csrf') return new Response(JSON.stringify({ token: 't' }), { headers: { 'content-type': 'application/json' } });
    if (url === '/api/session') return new Response(JSON.stringify(sessions.length > 1 ? sessions.shift() : sessions[0]), { headers: { 'content-type': 'application/json' } });
    if (url === '/api/vote') return new Response(JSON.stringify({ error: 'Not signed in' }), { status: 401, headers: { 'content-type': 'application/json' } });
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.history.pushState({}, '', '/'); });

function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname}{l.search}</p>; }
const login = (path: string) => render(
  <MemoryRouter initialEntries={[path]}><AuthProvider><Routes><Route path="/login" element={<LoginPage />} /><Route path="*" element={<Where />} /></Routes></AuthProvider></MemoryRouter>);

describe('demo mode sign-in', () => {
  it('forwards an Access-identified admin straight to the safe next path, with no button at all', async () => {
    sessions = [{ user: ADMIN, authMode: 'demo', notices: [] }];
    login('/login?next=%2Fadmin%2Fc%2Fabc');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/admin/c/abc'));
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByText(/Microsoft/)).toBeNull();
  });

  it('without a next path, admins go to /admin and everyone else to /votes', async () => {
    sessions = [{ user: ADMIN, authMode: 'demo', notices: [] }];
    login('/login');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/admin'));
    cleanup();
    sessions = [{ user: STAFF, authMode: 'demo', notices: [] }];
    login('/login');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/votes'));
  });

  it('an unsafe next path is ignored (no open redirect)', async () => {
    sessions = [{ user: STAFF, authMode: 'demo', notices: [] }];
    login('/login?next=https%3A%2F%2Fevil.example%2F');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/votes'));
  });

  it('after a 401 (the user was cleared) /login reads the Access identity again by itself and forwards: no click', async () => {
    // The first answer is the state the 401 left behind (signed out); the page asks again and Access identifies the person.
    sessions = [{ user: null, authMode: 'demo', notices: [] }, { user: STAFF, authMode: 'demo', notices: [] }];
    login('/login?expired=1&next=%2Fv%2F' + 'a'.repeat(32));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/v/' + 'a'.repeat(32)));
    expect(calls.filter((c) => c === 'GET /api/session').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a 401 from any call goes to /login by itself (never a click), keeping where the person was', async () => {
    window.history.pushState({}, '', '/votes');
    await expect(api('GET', '/api/vote')).rejects.toThrow();
    expect(assign).toHaveBeenCalledWith('/login?expired=1&next=%2Fvotes');
  });

  it('only when Access genuinely sent no identity: a short message and a link to the Access sign-in, never a Microsoft button', async () => {
    sessions = [{ user: null, authMode: 'demo', notices: [] }];
    login('/login?next=%2Fvotes');
    const link = await screen.findByRole('link', { name: 'Sign in with your email code' });
    expect(link.getAttribute('href')).toBe('/cdn-cgi/access/login');
    expect(screen.getByText(/Cloudflare Access sign-in was not found/)).toBeTruthy();
    expect(screen.queryByText(/Microsoft/)).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('entra mode still shows the Microsoft button (unchanged)', async () => {
    sessions = [{ user: null, authMode: 'entra', notices: [] }];
    login('/login');
    expect((await screen.findByRole('link', { name: 'Sign in with Microsoft' })).getAttribute('href')).toBe('/auth/login');
  });
});
