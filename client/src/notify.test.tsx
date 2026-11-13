// Emailing staff while voting is open: counts only, honest about what is not set up.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NotifyPanel } from './pages/admin/NotifyPanel';
import { resetCsrf, type CampaignDetail } from './api';

const camp = (over: Partial<CampaignDetail> = {}) => ({ id: 'cid', title: 'T', status: 'open', closes_at: '2030-01-01T10:00:00Z', turnout: 0, candidates: [], eligible_emails: [], ...over }) as unknown as CampaignDetail;
const info = (over: Record<string, unknown> = {}) => ({
  configured: true, open: true, mailable: true, total: 10, reachable: 8, unreachable: 2, not_voted: 5, last_sent: { open: null, reminder: null, closing_soon: null }, min_interval_minutes: 60, ...over,
});
let calls: { method: string; url: string; body: unknown }[] = [];
let table: Record<string, unknown> = {};
beforeEach(() => {
  calls = []; table = {}; resetCsrf();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const hit = table[`${method} ${url}`];
    const ok = !(hit && (hit as { error?: string }).error);
    return new Response(JSON.stringify(url === '/api/csrf' ? { token: 't' } : hit ?? {}), { status: url === '/api/csrf' || ok ? 200 : 409, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('NotifyPanel', () => {
  it('says plainly when email is not set up', async () => {
    table['GET /api/campaigns/cid/notify'] = info({ configured: false });
    render(<NotifyPanel c={camp()} />);
    expect(await screen.findByText(/Email is not set up yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Remind/ })).toBeNull();
  });

  it('a vote open to all staff has nobody to write to', async () => {
    table['GET /api/campaigns/cid/notify'] = info({ mailable: false, total: 0, reachable: 0, not_voted: null });
    render(<NotifyPanel c={camp()} />);
    expect(await screen.findByText(/no list of people to write to/)).toBeTruthy();
  });

  it('shows counts only, and sends a reminder after confirming', async () => {
    table['GET /api/campaigns/cid/notify'] = info();
    table['POST /api/campaigns/cid/notify'] = { sent: 5, unreachable: 2 };
    const user = userEvent.setup();
    render(<NotifyPanel c={camp()} />);
    expect(await screen.findByText(/8 of 10 voters have a known email address \(2 cannot be reached by email\)\. 5 of them have not voted yet/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Remind people who have not voted' }));
    const dlg = await screen.findByRole('dialog');
    expect(within(dlg).getByText(/5 people/)).toBeTruthy();
    await user.click(within(dlg).getByRole('button', { name: 'Send to 5' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ kind: 'reminder' }));
    expect(await screen.findByText('Sent to 5 people.')).toBeTruthy();
  });

  it('shows the server\'s reason when a send is refused, and hides "closing soon" without a closing time', async () => {
    table['GET /api/campaigns/cid/notify'] = info();
    table['POST /api/campaigns/cid/notify'] = { error: 'This notice was sent less than 60 minutes ago', code: 'too_soon' };
    const user = userEvent.setup();
    render(<NotifyPanel c={camp({ closes_at: null })} />);
    expect(await screen.findByRole('button', { name: /Send “voting is open”/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /closing soon/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Send “voting is open”/ }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Send to 8' }));
    expect(await screen.findByText(/less than 60 minutes ago/)).toBeTruthy();
  });

  it('does not appear for a campaign that is not open', () => {
    const { container } = render(<NotifyPanel c={camp({ status: 'closed' })} />);
    expect(container.textContent).toBe('');
  });
});
