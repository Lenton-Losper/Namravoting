// Co-admins, observers and the second approver in the UI.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CampaignPage } from './pages/admin/CampaignPage';
import { ObserveCampaign, ObserveList } from './pages/Observe';
import { resetCsrf } from './api';

const ID = '50a77f0b-87bd-4f3f-b4fb-6833a94a1086';
const detail = (over: Record<string, unknown> = {}) => ({
  id: ID, title: 'Quarterly vote', description: null, status: 'open', opens_at: null, closes_at: null, eligibility: 'all', results_published: false, share_token: 'x'.repeat(32),
  share_url: 'http://localhost/v/x', turnout: 2, eligible_emails: [], umoja_active_count: 0, allow_edits_after_start: false, edited_after_start: [], my_role: 'owner', require_approval: false,
  candidates: [{ id: 'c1', name: 'Ann', bio: null, photo_url: null }, { id: 'c2', name: 'Ben', bio: null, photo_url: null }], ...over,
});
const team = (over: Record<string, unknown> = {}) => ({
  owner: { name: 'Olivia Owner', email: 'o@x.test' }, require_approval: false, my_role: 'owner', approval_valid_hours: 24,
  members: [{ oid: 'm1', role: 'co_admin', name: 'Cara Coadmin', email: 'c@x.test', added_at: '2026-01-01T00:00:00Z' }, { oid: 'm2', role: 'observer', name: 'Obi Observer', email: 'obi@x.test', added_at: '2026-01-01T00:00:00Z' }],
  approvals: [], ...over,
});
const approval = (over: Record<string, unknown> = {}) => ({
  id: 'a1', kind: 'reset', status: 'pending', payload: { reason: 'Wrong list shown' }, requested_at: '2026-01-02T00:00:00Z', decided_at: null, decision_note: null,
  executed_at: null, requested_by: 'o', requested_by_name: 'Olivia Owner', decided_by_name: null, executable: false, ...over,
});

let calls: { method: string; url: string; body: unknown }[] = [];
let table: Record<string, unknown> = {};
beforeEach(() => {
  calls = []; table = {}; resetCsrf();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const body = url === '/api/csrf' ? { token: 't' } : table[`${method} ${url}`] ?? {};
    return new Response(JSON.stringify(body), { status: method === 'POST' && url.endsWith('/team') ? 201 : 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const campaign = async (d: object, tm: object) => {
  table[`GET /api/campaigns/${ID}`] = d; table[`GET /api/campaigns/${ID}/team`] = tm;
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={[`/admin/c/${ID}`]}><Routes><Route path="/admin/c/:id" element={<CampaignPage />} /></Routes></MemoryRouter>);
  return user;
};

describe('co-admin', () => {
  it('sees how to run the campaign but not reset, delete, archive or the team controls', async () => {
    const user = await campaign(detail({ my_role: 'co_admin', status: 'closed' }), team({ my_role: 'co_admin' }));
    expect(await screen.findByText(/You are a co-admin/)).toBeTruthy();
    for (const name of ['Reset votes', 'Archive', 'Delete permanently']) expect(screen.queryByRole('button', { name })).toBeNull();
    await user.click(screen.getByRole('tab', { name: 'Team' }));
    expect(await screen.findByText('Cara Coadmin')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add to team' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Remove/ })).toBeNull();
  });

  it('can approve or reject a pending request, but cannot carry it out', async () => {
    table[`POST /api/campaigns/${ID}/approvals/a1/approve`] = {};
    const user = await campaign(detail({ my_role: 'co_admin', require_approval: true }), team({ my_role: 'co_admin', require_approval: true, approvals: [approval()] }));
    await user.click(await screen.findByRole('tab', { name: 'Team' }));
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/approvals/a1/approve'))).toBe(true));
    expect(screen.queryByRole('button', { name: 'Carry it out now' })).toBeNull();
  });
});

describe('owner', () => {
  it('adds an observer by email, and can require a second approver', async () => {
    const user = await campaign(detail(), team());
    await user.click(await screen.findByRole('tab', { name: 'Team' }));
    await user.type(await screen.findByLabelText(/^Email/), 'new@x.test');
    await user.click(screen.getByRole('button', { name: 'Add to team' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === `/api/campaigns/${ID}/team`)?.body).toEqual({ email: 'new@x.test', role: 'observer' }));
    await user.click(screen.getByRole('button', { name: 'Require a second approver' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url.endsWith('/approval-policy'))).toBe(true));
  });

  it('with the rule on, "Request reset" sends a request instead of resetting, and an approved one can be carried out', async () => {
    table[`POST /api/campaigns/${ID}/approvals`] = {};
    const user = await campaign(detail({ require_approval: true }), team({ require_approval: true, approvals: [approval({ status: 'approved', executable: true, decided_by_name: 'Cara Coadmin', decided_at: '2026-01-02T01:00:00Z' })] }));
    await user.click(await screen.findByRole('button', { name: 'Request reset' }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText(/Type the campaign title/), 'Quarterly vote');
    await user.type(within(dlg).getByLabelText(/^Reason/), 'Wrong candidate list shown');
    await user.click(within(dlg).getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === `/api/campaigns/${ID}/approvals`)?.body).toMatchObject({ kind: 'reset', confirm_title: 'Quarterly vote' }));
    expect(calls.some((c) => c.url.endsWith('/reset'))).toBe(false);
    expect(await screen.findByText(/Request sent/)).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Team' }));
    expect(await screen.findByRole('button', { name: 'Carry it out now' })).toBeTruthy();
  });
});

describe('observer pages', () => {
  const view = (over: Record<string, unknown> = {}) => ({
    id: ID, title: 'Chair', description: null, status: 'open', eligibility: 'all', owner: 'Olivia Owner', opens_at: null, closes_at: null, results_published: false, archived: false, require_approval: false,
    turnout: { votes: 4, eligible: null }, result: null, seal: null, notices: [], team: [{ name: 'Obi Observer', role: 'observer' }], approvals: [],
    audit: [{ seq: 1, at: '2026-01-01T00:00:00Z', action: 'campaign.create', actor: 'Olivia Owner', hash: 'h', details: { title: 'Chair' } }], ...over,
  });
  const page = () => render(<MemoryRouter initialEntries={[`/observe/${ID}`]}><Routes><Route path="/observe/:id" element={<ObserveCampaign />} /></Routes></MemoryRouter>);

  it('lists the campaigns you observe', async () => {
    table['GET /api/observe'] = { campaigns: [{ id: ID, title: 'Chair', status: 'open', owner: 'Olivia Owner', turnout: 4, closes_at: null, results_published: false, archived_at: null }] };
    render(<MemoryRouter><ObserveList /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: 'Chair' })).toBeTruthy();
    expect(screen.getByText(/4 votes cast/)).toBeTruthy();
  });

  it('while open: turnout and the audit trail, and a plain explanation that counts are hidden', async () => {
    table[`GET /api/observe/${ID}`] = view();
    page();
    expect(await screen.findByText(/Per-candidate results are hidden until voting closes/)).toBeTruthy();
    expect(screen.getByText('campaign.create')).toBeTruthy();
    expect(screen.queryByText(/Sealed result/)).toBeNull();
  });

  it('once closed: the sealed result with its verification', async () => {
    table[`GET /api/observe/${ID}`] = view({
      status: 'closed', result: { candidates: [{ id: 'a', name: 'Ann', votes: 3 }, { id: 'b', name: 'Ben', votes: 1 }], turnout: { votes: 4, eligible: null }, tie: null },
      seal: { chain_ok: true, chain_checked: 5, sealed: true, sealed_at: '2026-01-02T00:00:00Z', seal_hash: 'abc123', seal_seq: 4, tallies_match: true, receipts_match: true, sealed_tallies: [], sealed_turnout: 4 },
    });
    page();
    expect(await screen.findByText(/Verified: the result is sealed/)).toBeTruthy();
    expect(screen.getByText('Ann')).toBeTruthy();
    expect(screen.getByText('abc123')).toBeTruthy();
  });

  it('shows a plain message when you are not an observer of that campaign', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/csrf' ? { token: 't' } : { error: 'Not found' }), { status: url === '/api/csrf' ? 200 : 404, headers: { 'content-type': 'application/json' } })));
    page();
    expect(await screen.findByText('You are not observing this campaign.')).toBeTruthy();
  });
});
