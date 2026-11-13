// Adding a late voter to a running vote.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LateVoters } from './pages/admin/LateVoters';
import { resetCsrf, type CampaignDetail } from './api';

const camp = (over: Partial<CampaignDetail> = {}) => ({ id: 'cid', title: 'T', status: 'open', eligibility: 'list', my_role: 'owner', ...over }) as unknown as CampaignDetail;
const late = (over: Record<string, unknown> = {}) => ({ enabled: true, applicable: true, mode: 'list', entries: [], ...over });
let calls: { method: string; url: string; body: unknown }[] = [];
let table: Record<string, unknown> = {};
beforeEach(() => {
  calls = []; table = {}; resetCsrf();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const hit = table[`${method} ${url}`] as { error?: string } | undefined;
    return new Response(JSON.stringify(url === '/api/csrf' ? { token: 't' } : hit ?? {}), { status: hit?.error ? 409 : method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('LateVoters', () => {
  it('adds a voter to a listed vote by email, with a reason of at least 10 characters', async () => {
    table['GET /api/campaigns/cid/late-voters'] = late();
    table['POST /api/campaigns/cid/late-voters'] = { added: true, email: 'new@x.test' };
    const reload = vi.fn(async () => undefined);
    const user = userEvent.setup();
    render(<LateVoters c={camp()} reload={reload} />);
    const add = await screen.findByRole('button', { name: 'Add late voter' });
    expect((add as HTMLButtonElement).disabled).toBe(true);
    await user.type(screen.getByLabelText(/^Email address/), 'new@x.test');
    await user.type(screen.getByLabelText(/^Reason/), 'Joined after voting began');
    await user.click(add);
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ email: 'new@x.test', reason: 'Joined after voting began' }));
    expect(await screen.findByText('new@x.test can now vote.')).toBeTruthy();
    expect(reload).toHaveBeenCalled();
  });

  it('asks for the employee code in an Umoja vote', async () => {
    table['GET /api/campaigns/cid/late-voters'] = late({ mode: 'umoja' });
    table['POST /api/campaigns/cid/late-voters'] = { added: true, employee_code: 'NAM0200' };
    const user = userEvent.setup();
    render(<LateVoters c={camp({ eligibility: 'umoja' })} reload={async () => undefined} />);
    await user.type(await screen.findByLabelText(/^Employee code/), 'NAM0200');
    await user.type(screen.getByLabelText(/^Reason/), 'Reinstated last week');
    await user.click(screen.getByRole('button', { name: 'Add late voter' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ employee_code: 'NAM0200', reason: 'Reinstated last week' }));
  });

  it('shows the server\'s reason when refused, and lists who was added, when and why', async () => {
    table['GET /api/campaigns/cid/late-voters'] = late({ entries: [{ at: '2026-01-02T08:00:00Z', by: 'Olivia Owner', identifier: 'old@x.test', reason: 'Hired on Monday' }] });
    table['POST /api/campaigns/cid/late-voters'] = { error: 'That email address is already on the voter list', code: 'already_listed' };
    const user = userEvent.setup();
    render(<LateVoters c={camp()} reload={async () => undefined} />);
    expect(await screen.findByText('old@x.test')).toBeTruthy();
    expect(screen.getByText(/Reason: Hired on Monday/)).toBeTruthy();
    await user.type(screen.getByLabelText(/^Email address/), 'dup@x.test');
    await user.type(screen.getByLabelText(/^Reason/), 'A perfectly good reason');
    await user.click(screen.getByRole('button', { name: 'Add late voter' }));
    expect(await screen.findByText('That email address is already on the voter list')).toBeTruthy();
  });

  it('shows nothing for a vote open to all staff, hides the form from a co-admin and after the vote closes', async () => {
    table['GET /api/campaigns/cid/late-voters'] = late({ applicable: false, mode: 'all' });
    const { container } = render(<LateVoters c={camp({ eligibility: 'all' })} reload={async () => undefined} />);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/late-voters'))).toBe(true));
    expect(container.textContent).toBe('');
    cleanup();
    table['GET /api/campaigns/cid/late-voters'] = late({ entries: [{ at: '2026-01-02T08:00:00Z', by: 'Olivia', identifier: 'a@x.test', reason: 'Hired on Monday' }] });
    render(<LateVoters c={camp({ my_role: 'co_admin' })} reload={async () => undefined} />);
    expect(await screen.findByText('a@x.test')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add late voter' })).toBeNull();
    cleanup();
    render(<LateVoters c={camp({ status: 'closed' })} reload={async () => undefined} />);
    expect(await screen.findByText('a@x.test')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add late voter' })).toBeNull();
  });
});
