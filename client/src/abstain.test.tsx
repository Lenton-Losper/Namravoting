// Abstain option: ballot line, confirmation wording, results shown separately, and the create form's setting.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { VotePage } from './pages/Vote';
import { NewCampaign } from './pages/admin/NewCampaign';
import { ResultsChart } from './ui';
import { resetCsrf } from './api';

let calls: { method: string; url: string; body: unknown }[] = [];
let table: Record<string, unknown> = {};
beforeEach(() => {
  calls = []; table = {}; resetCsrf(); sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    const body = url === '/api/csrf' ? { token: 't' } : table[`${method} ${url}`] ?? {};
    return new Response(JSON.stringify(body), { status: method === 'POST' && url === '/api/campaigns' ? 201 : 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('abstain', () => {
  it('results list candidates and show abstentions on their own line, never as a bar', () => {
    render(<ResultsChart turnout={{ votes: 5, eligible: null }} candidates={[{ id: 'a', name: 'Ann', votes: 2 }, { id: 'x', name: 'Abstain (none of the above)', votes: 3, is_abstain: true }]} />);
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
    expect(screen.getByText(/Abstentions \(not a candidate, never a winner\): 3/)).toBeTruthy();
    expect(document.querySelector('.leader')?.textContent).toContain('Ann');           // abstain has more votes but is not the leader
  });

  it('the ballot ends with the Abstain line and asks to confirm in its own words', async () => {
    const TOKEN = 'a'.repeat(32);
    table[`GET /api/vote/${TOKEN}`] = { title: 'T', description: null, opensAt: null, closesAt: null, resultsPublished: false, voterState: 'can_vote', notices: [],
      candidates: [{ id: 'c1', name: 'Ann', bio: null, photoUrl: null }, { id: 'ab', name: 'Abstain (none of the above)', bio: null, photoUrl: null, isAbstain: true }] };
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={[`/v/${TOKEN}`]}><Routes><Route path="/v/:shareToken" element={<VotePage />} /></Routes></MemoryRouter>);
    const radios = await screen.findAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual([expect.stringContaining('Ann'), expect.stringContaining('Abstain (none of the above)')]);
    await user.click(radios[1]);
    await user.click(screen.getByRole('button', { name: 'Cast vote' }));
    expect(await screen.findByRole('heading', { name: 'Abstain from this vote?' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Confirm vote' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ candidateId: 'ab' }));   // it is voted like any candidate
  });

  it('the create form sends the setting, off by default', async () => {
    const user = userEvent.setup();
    table['POST /api/campaigns'] = { id: 'new' };
    render(<MemoryRouter><NewCampaign /></MemoryRouter>);
    await user.type(screen.getByLabelText(/^Title/), 'T1');
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ allow_abstain: false }));
    cleanup(); calls = [];
    render(<MemoryRouter><NewCampaign /></MemoryRouter>);
    await user.type(screen.getByLabelText(/^Title/), 'T2');
    await user.click(screen.getByLabelText(/Abstain \(none of the above\)/));
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ allow_abstain: true }));
  });
});
