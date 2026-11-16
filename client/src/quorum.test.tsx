// Quorum in the UI. (Publishing and scheduled publishing are gone: see announce.test.tsx for "Announce winners".)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CampaignPage } from './pages/admin/CampaignPage';
import { NewCampaign } from './pages/admin/NewCampaign';
import { ResultsChart } from './ui';
import { resetCsrf } from './api';

const ID = '50a77f0b-87bd-4f3f-b4fb-6833a94a1086';
const detail = (over: Record<string, unknown> = {}) => ({
  id: ID, title: 'Quarterly vote', description: null, status: 'closed', opens_at: null, closes_at: null, eligibility: 'list', results_published: false, share_token: 'x'.repeat(32),
  share_url: 'http://localhost/v/x', turnout: 2, eligible_emails: ['a@x.test'], umoja_active_count: 0, allow_edits_after_start: false, edited_after_start: [], my_role: 'owner', publish_at: null,
  candidates: [{ id: 'c1', name: 'Ann', bio: null, photo_url: null }, { id: 'c2', name: 'Ben', bio: null, photo_url: null }], ...over,
});
const notMet = { percent: 75, eligible: 4, needed: 3, votes: 2, met: false };
const results = (over: Record<string, unknown> = {}) => ({
  status: 'closed', results_published: false, candidates: [{ id: 'c1', name: 'Ann', votes: 2 }, { id: 'c2', name: 'Ben', votes: 0 }], turnout: { votes: 2, eligible: 4 },
  tie: null, runoff: { round: 0, max: 2, next: null, parent: null, can_start: false }, quorum: notMet, publication: null, notices: [], ...over,
});

let calls: { method: string; url: string; body: unknown }[] = [];
let table: Record<string, unknown> = {};
beforeEach(() => {
  calls = []; table = {}; resetCsrf(); sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify(url === '/api/csrf' ? { token: 't' } : table[`${method} ${url}`] ?? {}), { status: method === 'POST' && url === '/api/campaigns' ? 201 : 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const campaign = async (d: object, r: object) => {
  table[`GET /api/campaigns/${ID}`] = d; table[`GET /api/campaigns/${ID}/results`] = r;
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={[`/admin/c/${ID}`]}><Routes><Route path="/admin/c/:id" element={<CampaignPage />} /></Routes></MemoryRouter>);
  await user.click(await screen.findByRole('tab', { name: /Results/ }));
  return user;
};

describe('quorum', () => {
  it('the results state plainly that the quorum was not met, and when it was', () => {
    const { rerender } = render(<ResultsChart candidates={[{ id: 'a', name: 'Ann', votes: 2 }]} turnout={{ votes: 2, eligible: 4 }} quorum={notMet} />);
    expect(screen.getByRole('status').textContent).toContain('Quorum NOT met: only 2 of the 3 votes needed (75% of 4 eligible voters)');
    rerender(<ResultsChart candidates={[{ id: 'a', name: 'Ann', votes: 3 }]} turnout={{ votes: 3, eligible: 4 }} quorum={{ ...notMet, votes: 3, met: true }} />);
    expect(screen.getByRole('status').textContent).toContain('Quorum met: 3 of the 3 votes needed');
  });

  it('the create form sends a quorum for a listed vote, and disables it for all staff', async () => {
    const user = userEvent.setup();
    table['POST /api/campaigns'] = { id: 'new' };
    render(<MemoryRouter><NewCampaign /></MemoryRouter>);
    await user.type(screen.getByLabelText(/^Title/), 'T');
    const q = screen.getByLabelText(/^Quorum/) as HTMLInputElement;
    expect(q.disabled).toBe(false);                                                        // the default (Umoja members) has a known list
    await user.type(q, '60');
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === '/api/campaigns')?.body).toMatchObject({ quorum_percent: 60 }));
    cleanup();
    render(<MemoryRouter><NewCampaign /></MemoryRouter>);
    await user.click(screen.getByLabelText(/All signed-in NamRA staff/));
    expect((screen.getByLabelText(/^Quorum/) as HTMLInputElement).disabled).toBe(true);
  });
});
