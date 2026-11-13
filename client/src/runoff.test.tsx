// Ties: the results say so plainly and the creator can start a run-off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CampaignPage } from './pages/admin/CampaignPage';
import { ResultsChart } from './ui';
import { resetCsrf } from './api';

const ID = '50a77f0b-87bd-4f3f-b4fb-6833a94a1086';
const detail = { id: ID, title: 'Chair', description: null, status: 'closed', opens_at: null, closes_at: null, eligibility: 'all', results_published: false, share_token: 'x'.repeat(32),
  share_url: 'http://localhost/v/x', turnout: 2, eligible_emails: [], umoja_active_count: 0, allow_edits_after_start: false, edited_after_start: [],
  candidates: [{ id: 'c1', name: 'Ann', bio: null, photo_url: null }, { id: 'c2', name: 'Ben', bio: null, photo_url: null }] };
const results = (over: object) => ({ status: 'closed', results_published: false, candidates: [{ id: 'c1', name: 'Ann', votes: 1 }, { id: 'c2', name: 'Ben', votes: 1 }],
  turnout: { votes: 2, eligible: null }, tie: { names: ['Ann', 'Ben'], votes: 1 }, runoff: { round: 0, max: 2, next: null, parent: null, can_start: true }, notices: [], ...over });

let calls: { method: string; url: string }[] = [];
let table: Record<string, unknown> = {};
beforeEach(() => {
  calls = []; table = {}; resetCsrf();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    const body = url === '/api/csrf' ? { token: 't' } : table[`${method} ${url}`] ?? {};
    return new Response(JSON.stringify(body), { status: method === 'POST' && url.endsWith('/runoff') ? 201 : 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const page = async () => {
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={[`/admin/c/${ID}?tab=results`]}><Routes>
  <Route path="/admin/c/:id" element={<CampaignPage />} /><Route path="/admin/c/:id/edit" element={<p>edit</p>} />
</Routes></MemoryRouter>);
  await user.click(await screen.findByRole('tab', { name: /Results/ }));
};

describe('tie display and run-off', () => {
  it('ResultsChart says who tied and that there is no winner yet', () => {
    render(<ResultsChart candidates={[{ id: 'a', name: 'Ann', votes: 2 }, { id: 'b', name: 'Ben', votes: 2 }]} turnout={{ votes: 4, eligible: null }} tie={{ names: ['Ann', 'Ben'], votes: 2 }} />);
    expect(screen.getByRole('status').textContent).toContain('Tie for first place: Ann and Ben each have 2 votes. There is no winner yet.');
  });

  it('offers "Start run-off" on a tied, closed campaign and creates it', async () => {
    table[`GET /api/campaigns/${ID}`] = detail;
    table[`GET /api/campaigns/${ID}/results`] = results({});
    table['GET /api/campaigns/new-id'] = { ...detail, id: 'new-id', title: 'Chair (run-off 1)', status: 'draft' };
    table[`POST /api/campaigns/${ID}/runoff`] = { id: 'new-id', title: 'Chair (run-off 1)', status: 'draft' };
    const user = userEvent.setup();
    await page();
    await user.click(await screen.findByRole('button', { name: 'Start run-off' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === `/api/campaigns/${ID}/runoff`)).toBe(true));
  });

  it('after the limit is reached it explains instead of offering a button, and a started run-off is linked', async () => {
    table[`GET /api/campaigns/${ID}`] = detail;
    table[`GET /api/campaigns/${ID}/results`] = results({ runoff: { round: 2, max: 2, next: null, parent: { id: 'p', title: 'Chair' }, can_start: false } });
    await page();
    expect(await screen.findByText(/limit of 2 run-off rounds has been reached/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start run-off' })).toBeNull();
    cleanup();
    table[`GET /api/campaigns/${ID}/results`] = results({ runoff: { round: 0, max: 2, next: { id: 'n', title: 'Chair (run-off 1)', status: 'draft' }, parent: null, can_start: false } });
    await page();
    expect(await screen.findByRole('link', { name: 'Chair (run-off 1)' })).toBeTruthy();
  });
});
