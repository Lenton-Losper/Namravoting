// The ballot with a pick range and a region rule: "Choose 4" / "Choose up to 4", the rule sentence, the "Outside Khomas: 1 of 2 needed"
// counter, Submit held back with a clear message, and cards greyed out (with an explanation on tap) when one more pick would make the rule impossible.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { resetCsrf } from './api';
import { VotePage } from './pages/Vote';
import { pickLabel } from './pages/VoteBlocks';

const TOKEN = 'c'.repeat(32);
const URL_INFO = `GET /api/vote/${TOKEN}`;
const URL_POS = `/api/vote/${TOKEN}/positions/p1`;

let table: Record<string, unknown> = {};
let calls: { method: string; url: string; body: unknown }[] = [];
beforeEach(() => {
  table = {}; calls = []; resetCsrf(); sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    const body = url === '/api/csrf' ? { token: 't' } : table[`${method} ${url}`] ?? {};
    return new Response(JSON.stringify(body), { status: method === 'POST' ? 201 : 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const REGIONS = [{ id: 'kh', name: 'Khomas' }, { id: 'er', name: 'Erongo' }, { id: 'oh', name: 'Ohangwena' }];
const cand = (id: string, name: string, regionId: string, region: string) => ({ id, name, bio: null, pledge: null, photoUrl: null, isAbstain: false, withdrawn: false, positionId: 'p1', regionId, region });
const CANDS = [cand('k1', 'Kay One', 'kh', 'Khomas'), cand('k2', 'Kay Two', 'kh', 'Khomas'), cand('k3', 'Kay Three', 'kh', 'Khomas'),
  cand('e1', 'Eli One', 'er', 'Erongo'), cand('o1', 'Ola One', 'oh', 'Ohangwena'), cand('e2', 'Eli Two', 'er', 'Erongo')];
const RULE = { minOutside: 2, regionId: 'kh', regionName: 'Khomas', text: 'At least 2 picks from outside Khomas' };

function open(picks: { min: number; max: number }, rule: typeof RULE | null = RULE) {
  const rules = { minPicks: picks.min, maxPicks: picks.max, chooseLabel: pickLabel(picks.min, picks.max), regionRule: rule };
  table[URL_INFO] = { title: 'Umoja Committee 2026', description: null, opensAt: null, closesAt: '2030-01-01T10:00:00Z', resultsReleaseAt: null, groupByRegion: false, voterState: 'can_vote', notices: [], candidates: [], progress: { voted: 0, total: 1 },
    positions: [{ id: 'p1', title: 'Additional Members', description: null, seats: 4, voted: false, candidateCount: 6, receiptCode: null, ...rules }] };
  table[`GET ${URL_POS}`] = { position: { id: 'p1', title: 'Additional Members', description: null, seats: 4, ...rules }, campaign: { title: 'Umoja Committee 2026', closesAt: null }, groupByRegion: false, voterState: 'can_vote', regions: REGIONS, progress: { voted: 0, total: 1 }, candidates: CANDS };
  return render(<MemoryRouter initialEntries={[`/v/${TOKEN}`]}><Routes><Route path="/v/:shareToken" element={<VotePage />} /></Routes></MemoryRouter>);
}
const one = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}\\b`) }) as HTMLButtonElement;
const counter = () => screen.getByTestId('region-counter').textContent;

describe('labels', () => {
  it('"Choose 4" for an exact count, "Choose up to 4" and "Choose 2 to 4" for a range', () => {
    expect(pickLabel(4, 4)).toBe('Choose 4');
    expect(pickLabel(1, 4)).toBe('Choose up to 4');
    expect(pickLabel(2, 4)).toBe('Choose 2 to 4');
  });
  it('the ballot says "Choose 4" for an exact count', async () => {
    open({ min: 4, max: 4 });
    expect(await screen.findByText('Step 1 of 2 · Choose 4')).toBeTruthy();
  });
  it('and "Choose up to 4" for a range', async () => {
    open({ min: 1, max: 4 });
    expect(await screen.findByText('Step 1 of 2 · Choose up to 4')).toBeTruthy();
    expect(screen.getByText("Pick up to 4 candidates. You'll see your choices again before anything is submitted.")).toBeTruthy();
  });
});

describe('the region rule on the ballot', () => {
  it('shows the generated rule sentence and the counter before anything is picked', async () => {
    open({ min: 4, max: 4 });
    await screen.findByRole('button', { name: /^Kay One\b/ });
    expect(screen.getByText('At least 2 picks from outside Khomas')).toBeTruthy();
    expect(counter()).toBe('Outside Khomas: 0 of 2 needed');
  });

  it('counts picks from outside the region, holds Submit back with a message until the rule is met, then lets it through', async () => {
    open({ min: 4, max: 4 }); const user = userEvent.setup();
    await screen.findByRole('button', { name: /^Kay One\b/ });
    await user.click(one('Kay One')); await user.click(one('Kay Two')); await user.click(one('Eli One'));
    expect(counter()).toBe('Outside Khomas: 1 of 2 needed');
    expect(screen.getByText('Pick 1 more from outside Khomas to continue.')).toBeTruthy();
    expect((screen.getByRole('button', { name: '3 of 4 selected' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(one('Ola One'));
    expect(counter()).toBe('Outside Khomas: 2 of 2 needed ✓');
    expect(screen.queryByText(/more from outside/)).toBeNull();
    expect((screen.getByRole('button', { name: 'Review 4 votes' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('greys out the remaining Khomas cards when one more would make the rule impossible, and explains why on tap', async () => {
    open({ min: 4, max: 4 }); const user = userEvent.setup();
    await screen.findByRole('button', { name: /^Kay One\b/ });
    await user.click(one('Kay One'));
    expect(one('Kay Two').getAttribute('aria-disabled')).toBeNull();            // 3 places left, 2 outside needed: one more Khomas is fine
    await user.click(one('Kay Two'));
    for (const n of ['Kay Three']) {
      expect(one(n).getAttribute('aria-disabled')).toBe('true');                  // 2 places left and 2 outside needed
      expect(one(n).closest('.ballot-card')?.classList.contains('is-blocked')).toBe(true);
    }
    expect(one('Eli One').getAttribute('aria-disabled')).toBeNull();            // outside candidates are never blocked
    await user.click(one('Kay Three'));
    expect(one('Kay Three').getAttribute('aria-pressed')).toBe('false');         // not added
    expect(screen.getByRole('alert').textContent).toMatch(/can't add another Khomas candidate.*still need 2 from outside Khomas.*2 places are left/);
    await user.click(one('Kay One'));                                            // taking one off frees the place
    expect(one('Kay Three').getAttribute('aria-disabled')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('with "up to 4" the rule still has to be met: 2 from outside Khomas, then Review', async () => {
    open({ min: 1, max: 4 }); const user = userEvent.setup();
    await screen.findByRole('button', { name: /^Kay One\b/ });
    await user.click(one('Kay One'));
    expect((screen.getByRole('button', { name: '1 selected' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Pick 2 more from outside Khomas to continue.')).toBeTruthy();
    await user.click(one('Eli One')); await user.click(one('Ola One'));
    expect((screen.getByRole('button', { name: 'Review 3 votes' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('sends every pick in one request once confirmed', async () => {
    open({ min: 4, max: 4 }); table[`POST ${URL_POS}`] = { recorded: true, receiptCode: 'UV-7K3M-Q9TD' };
    const user = userEvent.setup();
    await screen.findByRole('button', { name: /^Kay One\b/ });
    for (const n of ['Kay One', 'Kay Two', 'Eli One', 'Ola One']) await user.click(one(n));
    await user.click(screen.getByRole('button', { name: 'Review 4 votes' }));
    await user.click(await screen.findByRole('button', { name: 'Submit my vote' }));
    await screen.findByText('Your vote is in');
    expect((calls.find((c) => c.method === 'POST' && c.url === URL_POS)?.body as { candidateIds: string[] }).candidateIds).toEqual(['k1', 'k2', 'e1', 'o1']);
  });

  it('no rule, no counter', async () => {
    open({ min: 4, max: 4 }, null);
    await screen.findByRole('button', { name: /^Kay One\b/ });
    expect(screen.queryByTestId('region-counter')).toBeNull();
  });
});
