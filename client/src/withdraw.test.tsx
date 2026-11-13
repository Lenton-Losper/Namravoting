// A candidate withdraws after voting has started.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CampaignPage } from './pages/admin/CampaignPage';
import { VotePage } from './pages/Vote';
import { ResultsChart } from './ui';
import { resetCsrf } from './api';

const ID = '50a77f0b-87bd-4f3f-b4fb-6833a94a1086';
const cand = (id: string, name: string, extra = {}) => ({ id, name, bio: null, photo_url: null, ...extra });
const detail = (candidates: object[]) => ({
  id: ID, title: 'Quarterly vote', description: null, status: 'open', opens_at: null, closes_at: null, eligibility: 'all', results_published: false, share_token: 'x'.repeat(32),
  share_url: 'http://localhost/v/x', turnout: 2, eligible_emails: [], umoja_active_count: 0, allow_edits_after_start: false, edited_after_start: [], my_role: 'owner', candidates,
});

let calls: { method: string; url: string; body: unknown }[] = [];
let table: Record<string, unknown> = {};
beforeEach(() => {
  calls = []; table = {}; resetCsrf(); sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const body = url === '/api/csrf' ? { token: 't' } : table[`${method} ${url}`] ?? {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('results', () => {
  it('a withdrawn candidate is not a bar and not the leader; their void votes are stated separately', () => {
    render(<ResultsChart turnout={{ votes: 6, eligible: null }} candidates={[{ id: 'a', name: 'Ann', votes: 4, withdrawn: true }, { id: 'b', name: 'Ben', votes: 2 }, { id: 'c', name: 'Cy', votes: 0 }]} />);
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
    expect(document.querySelector('.leader')?.textContent).toContain('Ben');
    expect(screen.getByText(/Ann withdrew: 4 votes void/)).toBeTruthy();
  });
});

describe('ballot', () => {
  it('greys out a withdrawn candidate so it cannot be chosen, and says why', async () => {
    const TOKEN = 'a'.repeat(32);
    table[`GET /api/vote/${TOKEN}`] = {
      title: 'T', description: null, opensAt: null, closesAt: null, resultsPublished: false, voterState: 'can_vote',
      notices: [{ kind: 'candidate_withdrawn', at: '2026-01-01T10:00:00Z', by: 'Olivia', reason: 'Withdrew for personal reasons', candidate: 'Ann' }],
      candidates: [{ id: 'c1', name: 'Ann', bio: 'bio', photoUrl: null, withdrawn: true }, { id: 'c2', name: 'Ben', bio: null, photoUrl: null }],
    };
    render(<MemoryRouter initialEntries={[`/v/${TOKEN}`]}><Routes><Route path="/v/:shareToken" element={<VotePage />} /></Routes></MemoryRouter>);
    const ann = (await screen.findAllByRole('radio')).find((r) => r.textContent?.includes('Ann'))!;
    expect((ann as HTMLButtonElement).disabled).toBe(true);
    expect(ann.textContent).toContain('this candidate can no longer be chosen');
    expect(screen.getByText(/Ann withdrew on/)).toBeTruthy();
    expect(screen.getByText(/votes already cast for them are void/)).toBeTruthy();
  });
});

describe('creator', () => {
  const page = async (candidates: object[]) => {
    table[`GET /api/campaigns/${ID}`] = detail(candidates);
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={[`/admin/c/${ID}`]}><Routes><Route path="/admin/c/:id" element={<CampaignPage />} /></Routes></MemoryRouter>);
    return user;
  };

  it('withdraws a candidate with a reason of at least 10 characters', async () => {
    const user = await page([cand('c1', 'Ann'), cand('c2', 'Ben'), cand('c3', 'Cy')]);
    await user.click((await screen.findAllByRole('button', { name: 'Withdraw…' }))[0]);
    const dlg = await screen.findByRole('dialog');
    const confirm = within(dlg).getByRole('button', { name: 'Withdraw candidate' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.type(within(dlg).getByLabelText(/^Reason/), 'Withdrew for personal reasons');
    await user.click(confirm);
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === `/api/campaigns/${ID}/candidates/c1/withdraw`)?.body).toEqual({ reason: 'Withdrew for personal reasons' }));
  });

  it('cannot withdraw when only 2 candidates are in the running, and shows who already withdrew', async () => {
    const user = await page([cand('c1', 'Ann', { withdrawn_at: '2026-01-01T00:00:00Z', withdrawn_reason: 'Left the company' }), cand('c2', 'Ben'), cand('c3', 'Cy')]);
    expect(await screen.findByText('Withdrew')).toBeTruthy();
    expect(screen.getByText(/Withdrew: Left the company/)).toBeTruthy();
    for (const b of screen.getAllByRole('button', { name: 'Withdraw…' })) expect((b as HTMLButtonElement).disabled).toBe(true);
    void user;
  });
});
