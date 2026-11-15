// AUTH_MODE=email-demo (DEMO ONLY): one email field and a Sign in button, for everyone; admins too, with no password.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { resetCsrf, resetSessionExpiredGuard } from './api';
import { AuthProvider } from './auth';
import { LoginPage } from './pages/Login';

const ADMIN = { oid: 'o1', email: 'lenton.losper@namra.org.na', displayName: 'Lenton Losper', roles: ['CampaignAdmin'], employeeCode: 'TST0026' };
const STAFF = { oid: 's1', email: 'sam@namra.org.na', displayName: 'Sam', roles: [], employeeCode: null };

let signedIn: object | null;
let posts: unknown[];
let answer: (body: { email: string }) => { status: number; body: unknown };
beforeEach(() => {
  signedIn = null; posts = []; resetCsrf(); resetSessionExpiredGuard();
  answer = (b) => ({ status: 200, body: { user: b.email.includes('lenton') ? ADMIN : STAFF } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === '/api/csrf') return json(200, { token: 't' });
    if (url === '/api/session') return json(200, { user: signedIn, authMode: 'email-demo', notices: [] });
    if (url === '/api/email-login') {
      const b = JSON.parse(String(init?.body)); posts.push(b);
      const a = answer(b);
      if (a.status === 200) signedIn = (a.body as { user: object }).user;
      return json(a.status, a.body);
    }
    return json(200, {});
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Where() { const l = useLocation(); return <p data-testid="where">{l.pathname}</p>; }
const page = (path = '/login') => render(
  <MemoryRouter initialEntries={[path]}><AuthProvider><Routes><Route path="/login" element={<LoginPage />} /><Route path="*" element={<Where />} /></Routes></AuthProvider></MemoryRouter>);

describe('email-demo sign-in page', () => {
  it('shows one email field, a Sign in button and the "Demo sign-in" note, and no Microsoft button or password field', async () => {
    page();
    expect(await screen.findByLabelText('Email address')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByText(/Demo sign-in/)).toBeTruthy();
    expect(screen.queryByText(/Microsoft/)).toBeNull();
    expect(screen.queryByLabelText(/password/i)).toBeNull();
  });

  it('a staff member types their email and goes to the safe next path (or /votes)', async () => {
    const user = userEvent.setup();
    page('/login?next=%2Fv%2F' + 'a'.repeat(32));
    await user.type(await screen.findByLabelText('Email address'), 'Sam@NamRA.org.na');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/v/' + 'a'.repeat(32)));
    expect(posts).toEqual([{ email: 'Sam@NamRA.org.na' }]);                    // the server trims and lower-cases
  });

  it('an admin signs in the same way, with just the email (no password field ever appears), and goes to /admin', async () => {
    const user = userEvent.setup();
    page();
    await user.type(await screen.findByLabelText('Email address'), 'lenton.losper@namra.org.na');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/admin'));
    expect(posts).toEqual([{ email: 'lenton.losper@namra.org.na' }]);
    expect(document.querySelector('input[type="password"]')).toBeNull();
  });

  it('shows the server\'s refusal for an address outside @namra.org.na', async () => {
    answer = () => ({ status: 403, body: { error: 'Use your @namra.org.na email address', code: 'email_not_allowed' } });
    const user = userEvent.setup();
    page();
    await user.type(await screen.findByLabelText('Email address'), 'someone@gmail.com');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Use your @namra.org.na email address')).toBeTruthy();
  });

  it('someone already signed in goes straight on, without the form', async () => {
    signedIn = STAFF;
    page('/login');
    await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/votes'));
  });
});
