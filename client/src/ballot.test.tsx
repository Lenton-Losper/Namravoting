// The redesigned ballot screens (VoteBlocks.tsx): card content, the choose -> confirm -> receipt flow, the states around it, the results date
// on the campaign forms, the stylesheet's card layout, and an axe (WCAG 2.1 A and AA) check on EVERY new screen.
import axe from 'axe-core';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { resetCsrf } from './api';
import { VotePage } from './pages/Vote';
import { cardLine } from './pages/VoteBlocks';
import { NewCampaign } from './pages/admin/NewCampaign';
import { EditCampaign } from './pages/admin/EditCampaign';

const TOKEN = 'b'.repeat(32);
const ID = '50a77f0b-87bd-4f3f-b4fb-6833a94a1086';
const URL_INFO = `GET /api/vote/${TOKEN}`;
const URL_POS = `/api/vote/${TOKEN}/positions/p1`;
const CODE = 'UV-7K3M-Q9TD';

let calls: { method: string; url: string; body: unknown }[] = [];
let table: Record<string, unknown> = {};
let statuses: Record<string, number> = {};
beforeEach(() => {
  calls = []; table = {}; statuses = {}; resetCsrf(); sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    const body = url === '/api/csrf' ? { token: 't' } : table[`${method} ${url}`] ?? {};
    return new Response(JSON.stringify(body), { status: statuses[`${method} ${url}`] ?? (method === 'POST' && url === '/api/campaigns' ? 201 : 200), headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function audit(container: HTMLElement) {
  const r = await axe.run(container, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }, rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.slice(0, 4).map((n) => n.target.join(' ')).join('\n    ')}`);
}
const page = () => render(<MemoryRouter initialEntries={[`/v/${TOKEN}`]}><Routes><Route path="/v/:shareToken" element={<VotePage />} /><Route path="/votes" element={<p>My votes page</p>} /></Routes></MemoryRouter>);

const REGIONS = [{ id: 'r1', name: 'Erongo' }, { id: 'r2', name: 'Khomas' }];
const cand = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, bio: null, pledge: null, photoUrl: null, isAbstain: false, withdrawn: false, positionId: 'p1', regionId: 'r2', region: 'Khomas', ...extra });
const ABSTAIN = cand('ab', 'Abstain (none of the above)', { isAbstain: true, regionId: null, region: null });
const CANDS = [
  cand('c1', 'Alice Amutenya', { pledge: 'Open books, every quarter.', bio: 'Alice has kept the books for ten years.\n\nShe wants every member to see where the money goes.' }),
  cand('c2', 'Ben Basson', { regionId: 'r1', region: 'Erongo', bio: 'Ben has been a branch treasurer.' }),
  cand('c3', 'Cy Cloete', { withdrawn: true }),
];
const info = (over: Record<string, unknown> = {}, positions?: unknown[]) => ({
  title: 'Umoja Committee 2026', description: null, opensAt: null, closesAt: '2030-01-01T10:00:00Z', resultsReleaseAt: '2030-01-05T08:00:00Z', groupByRegion: false, resultsPublished: false,
  voterState: 'can_vote', notices: [], candidates: [], progress: { voted: 0, total: 1 },
  positions: positions ?? [{ id: 'p1', title: 'Finance Officer', description: 'Keeps the books', seats: 1, voted: false, candidateCount: 2, receiptCode: null }], ...over,
});
const two = [{ id: 'p1', title: 'Finance Officer', description: 'Keeps the books', seats: 1, voted: false, candidateCount: 2, receiptCode: null }, { id: 'p2', title: 'Treasurer', description: null, seats: 1, voted: true, candidateCount: 3, receiptCode: CODE }];
const ballot = (cands: unknown[] = [...CANDS, ABSTAIN], over: Record<string, unknown> = {}) => ({
  position: { id: 'p1', title: 'Finance Officer', description: 'Keeps the books' }, campaign: { title: 'Umoja Committee 2026', closesAt: '2030-01-01T10:00:00Z', resultsReleaseAt: '2030-01-05T08:00:00Z' },
  groupByRegion: false, voterState: 'can_vote', regions: REGIONS, progress: { voted: 0, total: 1 }, candidates: cands, ...over,
});
const many = Array.from({ length: 9 }, (_, i) => cand(`m${i}`, `Candidate ${i + 1}`, { regionId: i % 2 ? 'r1' : 'r2', region: i % 2 ? 'Erongo' : 'Khomas', pledge: 'A pledge that is rather long and keeps going so that the card has to cut it off at some point, for sure.' }));

describe('a candidate card', () => {
  it('shows the photo (or initials), "Name – Region", and the pledge; falls back to the start of the bio; says when withdrawn', async () => {
    table[URL_INFO] = info(); table[`GET ${URL_POS}`] = ballot([...CANDS, cand('c4', 'Dee Dentlinger', { bio: 'word '.repeat(60), photoUrl: '/api/photos/c4' }), ABSTAIN]);
    page();
    const alice = await screen.findByRole('button', { name: /^Alice Amutenya/ });
    expect(alice.querySelector('.ballot-card-name')?.textContent).toBe('Alice Amutenya – Khomas');
    expect(alice.querySelector('.ballot-card-line')?.textContent).toBe('Open books, every quarter.');
    expect(alice.querySelector('.avatar-lg')?.textContent).toBe('AA');                       // no photo: initials, 96px
    const dee = screen.getByRole('button', { name: /^Dee Dentlinger/ });
    expect(dee.querySelector('img.avatar-lg')?.getAttribute('src')).toBe('/api/photos/c4');
    expect(dee.querySelector('img')?.getAttribute('alt')).toBe('');                          // decorative: the name is right next to it
    expect((dee.querySelector('.ballot-card-line')?.textContent ?? '').endsWith('…')).toBe(true);   // no pledge: the bio is cut, at a word
    const cy = screen.getByRole('button', { name: /^Cy Cloete/ }) as HTMLButtonElement;
    expect(cy.disabled).toBe(true);
    expect(cy.textContent).toContain('Withdrawn');
  });

  it('cardLine: the pledge wins; a short bio is kept whole; a long bio is cut near 140 characters at a word', () => {
    expect(cardLine({ pledge: ' Fair for all ', bio: 'x' })).toBe('Fair for all');
    expect(cardLine({ pledge: null, bio: 'Short   bio\nhere' })).toBe('Short bio here');
    const cut = cardLine({ pledge: '', bio: 'lorem '.repeat(60) });
    expect(cut.length).toBeLessThanOrEqual(141);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('cards go compact when there are many candidates, and the region filter appears', async () => {
    table[URL_INFO] = info(); table[`GET ${URL_POS}`] = ballot(many);
    page();
    await screen.findByLabelText('Region');
    expect(document.querySelectorAll('.ballot-card.is-compact')).toHaveLength(9);
  });

  it('a short list keeps the large cards and has no region filter', async () => {
    table[URL_INFO] = info(); table[`GET ${URL_POS}`] = ballot();
    page();
    await screen.findByRole('button', { name: /^Alice/ });
    expect(document.querySelector('.is-compact')).toBeNull();
    expect(screen.queryByLabelText('Region')).toBeNull();
  });
});

describe('choose, confirm, receipt', () => {
  it('a one-position campaign opens the ballot directly (no list of positions), with a link back to My votes', async () => {
    table[URL_INFO] = info(); table[`GET ${URL_POS}`] = ballot();
    page();
    expect(await screen.findByRole('heading', { name: 'Finance Officer' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Positions' })).toBeNull();
    expect(screen.getByText('Step 1 of 2 · Choose')).toBeTruthy();
    expect(screen.getByRole('link', { name: /My votes/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /All positions/ })).toBeNull();
  });

  it('review stays disabled until a choice is made; the confirm sheet shows the choice and sends nothing until "Submit my vote"', async () => {
    table[URL_INFO] = info(); table[`GET ${URL_POS}`] = ballot(); table[`POST ${URL_POS}`] = { recorded: true, receiptCode: CODE };
    const user = userEvent.setup();
    page();
    expect((await screen.findByRole('button', { name: 'Review vote' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Select a candidate to continue')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /^Ben Basson/ }));
    expect(screen.getByRole('button', { name: /^Ben Basson/ }).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Review vote for Ben' }));
    const sheet = screen.getByRole('dialog', { name: 'Confirm your vote' });
    expect(within(sheet).getByText('Step 2 of 2 · Confirm')).toBeTruthy();
    expect(within(sheet).getByText('Ben Basson')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.click(within(sheet).getByRole('button', { name: 'Change my choice' }));        // back to the choice, still selected
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: /^Ben Basson/ }).getAttribute('aria-pressed')).toBe('true');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Review vote for Ben' }));
    await user.keyboard('{Escape}');                                                           // Escape also goes back, without voting
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('submitting shows the receipt with the code and the results date; the choice is no longer on screen; Done goes on', async () => {
    table[URL_INFO] = info(); table[`GET ${URL_POS}`] = ballot(); table[`POST ${URL_POS}`] = { recorded: true, receiptCode: CODE };
    const user = userEvent.setup();
    page();
    await user.click(await screen.findByRole('button', { name: /^Ben Basson/ }));
    await user.click(screen.getByRole('button', { name: 'Review vote for Ben' }));
    table[URL_INFO] = info({ voterState: 'already_voted', progress: { voted: 1, total: 1 } }, [{ id: 'p1', title: 'Finance Officer', description: null, seats: 1, voted: true, candidateCount: 2, receiptCode: CODE }]);
    await user.click(screen.getByRole('button', { name: 'Submit my vote' }));
    expect(await screen.findByRole('heading', { name: 'Your vote is in' })).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST' && c.url === URL_POS)).toHaveLength(1);
    expect(calls.find((c) => c.method === 'POST' && c.url === URL_POS)?.body).toEqual({ candidateId: 'c2' });
    expect(screen.getByText(CODE)).toBeTruthy();
    expect(screen.getByText(/It doesn't show who you voted for/)).toBeTruthy();
    expect(screen.getByText(/Results will be shared on 5 Jan/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('Ben');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('heading', { name: "You've already voted" })).toBeTruthy();      // the true state, from the server
  });

  it('without a results date the receipt says results come after voting closes', async () => {
    table[URL_INFO] = info({ resultsReleaseAt: null }); table[`GET ${URL_POS}`] = ballot(undefined, { campaign: { title: 'T', closesAt: null, resultsReleaseAt: null } }); table[`POST ${URL_POS}`] = { recorded: true, receiptCode: CODE };
    const user = userEvent.setup();
    page();
    await user.click(await screen.findByRole('button', { name: /^Ben Basson/ }));
    await user.click(screen.getByRole('button', { name: 'Review vote for Ben' }));
    await user.click(screen.getByRole('button', { name: 'Submit my vote' }));
    expect(await screen.findByText(/Results will be shared after voting closes/)).toBeTruthy();
  });

  it('abstaining is reviewed and confirmed in its own words, and voted like any candidate', async () => {
    table[URL_INFO] = info(); table[`GET ${URL_POS}`] = ballot(); table[`POST ${URL_POS}`] = { recorded: true, receiptCode: CODE };
    const user = userEvent.setup();
    page();
    await user.click(await screen.findByRole('button', { name: /Abstain/ }));
    await user.click(screen.getByRole('button', { name: 'Review: abstain' }));
    expect(within(screen.getByRole('dialog')).getByText(/none of the above/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Submit my vote' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === URL_POS)?.body).toEqual({ candidateId: 'ab' }));
  });

  it('a network failure after submitting asks the server; if it cannot be reached the voter is told NOT to vote again yet', async () => {
    table[URL_INFO] = info(); table[`GET ${URL_POS}`] = ballot();
    const user = userEvent.setup();
    page();
    await user.click(await screen.findByRole('button', { name: /^Ben Basson/ }));
    await user.click(screen.getByRole('button', { name: 'Review vote for Ben' }));
    statuses[`POST ${URL_POS}`] = 500; statuses[`GET ${URL_POS}`] = 500;   // the server cannot be asked either
    await user.click(screen.getByRole('button', { name: 'Submit my vote' }));
    expect(await screen.findByRole('heading', { name: 'Your vote may not have been recorded' })).toBeTruthy();
    expect(screen.getByText(/do not vote again until you have checked/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Review vote/ })).toBeNull();
  });
});

describe('the statement and help sheets', () => {
  it('"Read full statement" opens the whole statement; choosing from it selects the card; Escape closes it', async () => {
    table[URL_INFO] = info(); table[`GET ${URL_POS}`] = ballot();
    const user = userEvent.setup();
    page();
    await user.click(await screen.findByRole('button', { name: 'Read full statement of Alice Amutenya' }));
    const sheet = screen.getByRole('dialog', { name: 'Statement of Alice Amutenya' });
    expect(within(sheet).getByText(/She wants every member to see where the money goes/)).toBeTruthy();
    expect(within(sheet).getByText(/Open books, every quarter/)).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Read full statement of Alice Amutenya' }));
    await user.click(screen.getByRole('button', { name: 'Choose Alice' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: /^Alice Amutenya/ }).getAttribute('aria-pressed')).toBe('true');
  });

  it('the help button explains the three steps and anonymity', async () => {
    table[URL_INFO] = info(); table[`GET ${URL_POS}`] = ballot();
    const user = userEvent.setup();
    page();
    await user.click(await screen.findByRole('button', { name: 'Help: how voting works' }));
    const sheet = screen.getByRole('dialog', { name: 'How voting works' });
    expect(within(sheet).getByText(/Your vote is anonymous/)).toBeTruthy();
    expect(within(sheet).getAllByRole('listitem').length).toBeGreaterThanOrEqual(5);
    await user.click(within(sheet).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('the states around the ballot', () => {
  it('already voted (one position): the receipt number again, and the results date', async () => {
    table[URL_INFO] = info({ voterState: 'already_voted', progress: { voted: 1, total: 1 } }, [{ id: 'p1', title: 'Finance Officer', description: null, seats: 1, voted: true, candidateCount: 2, receiptCode: CODE }]);
    page();
    expect(await screen.findByRole('heading', { name: "You've already voted" })).toBeTruthy();
    expect(screen.getByText(CODE)).toBeTruthy();
    expect(screen.getByText(/Results will be shared on 5 Jan/)).toBeTruthy();
  });
  it('already voted from before receipt numbers existed: no code panel, no crash', async () => {
    table[URL_INFO] = info({ voterState: 'already_voted', progress: { voted: 1, total: 1 } }, [{ id: 'p1', title: 'Finance Officer', description: null, seats: 1, voted: true, candidateCount: 2, receiptCode: null }]);
    page();
    expect(await screen.findByRole('heading', { name: "You've already voted" })).toBeTruthy();
    expect(screen.queryByText('Receipt number')).toBeNull();
  });
  it('not open yet, and closed (with and without a results date)', async () => {
    table[URL_INFO] = info({ voterState: 'not_open', opensAt: '2030-01-01T08:00:00Z' });
    const { unmount } = page();
    expect(await screen.findByRole('heading', { name: "Voting hasn't opened yet" })).toBeTruthy();
    unmount();
    table[URL_INFO] = info({ voterState: 'closed' });
    const second = page();
    expect(await screen.findByRole('heading', { name: 'Voting has closed' })).toBeTruthy();
    expect(screen.getByText(/Results will be shared on 5 Jan/)).toBeTruthy();
    second.unmount();
    table[URL_INFO] = info({ voterState: 'closed', resultsReleaseAt: null });
    page();
    expect(await screen.findByText('The results have not been published yet.')).toBeTruthy();
  });
});

describe('the results date on the campaign forms', () => {
  it('the new-campaign form sends it (and null when left empty)', async () => {
    const user = userEvent.setup();
    table['POST /api/campaigns'] = { id: 'new' };
    render(<MemoryRouter><NewCampaign /></MemoryRouter>);
    await user.type(screen.getByLabelText(/^Title/), 'T1');
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ results_release_at: null }));
    cleanup(); calls = [];
    render(<MemoryRouter><NewCampaign /></MemoryRouter>);
    await user.type(screen.getByLabelText(/^Title/), 'T2');
    await user.type(screen.getByLabelText(/^Results will be shared on/), '2030-01-05T08:00');
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ results_release_at: expect.stringMatching(/^2030-01-05T06:00:00/) }));   // 08:00 Windhoek (CAT, UTC+2)
  });

  it('the edit form shows the saved date and sends a change', async () => {
    const user = userEvent.setup();
    table[`GET /api/campaigns/${ID}`] = { id: ID, title: 'T', description: null, status: 'draft', opens_at: null, closes_at: null, results_release_at: '2030-01-05T06:00:00Z', eligibility: 'umoja', allow_abstain: false, allow_edits_after_start: false, quorum_percent: null, candidates: [], eligible_emails: [], turnout: 0, umoja_active_count: 0, my_role: 'owner' };
    render(<MemoryRouter initialEntries={[`/admin/c/${ID}/edit`]}><Routes><Route path="/admin/c/:id/edit" element={<EditCampaign />} /></Routes></MemoryRouter>);
    const field = (await screen.findByLabelText(/^Results will be shared on/)) as HTMLInputElement;
    expect(field.value).toBe('2030-01-05T08:00');
    await user.clear(field);
    await user.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({ results_release_at: null }));
  });
});

describe('the stylesheet follows the card design', () => {
  const css = readFileSync(path.resolve(__dirname, 'styles.css'), 'utf8');
  const rule = (selector: string) => {
    const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const m = new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`).exec(css);
    if (!m) throw new Error(`no rule for ${selector}`);
    return m[1];
  };
  it('the photo is 96px and centred above the name; the card has a 2px #8A94A3 border', () => {
    expect(rule('.avatar-lg')).toMatch(/width: 96px; height: 96px/);
    expect(rule('.ballot-card-main')).toMatch(/flex-direction: column; align-items: center/);
    expect(rule('.ballot-card')).toMatch(/border: 2px solid var\(--b-border\)/);
    expect(css).toMatch(/--b-border: #8A94A3/);
  });
  it('a selected card has the #12355B border, a 3px rgba(18,53,91,.18) glow and the #EEF3F9 fill', () => {
    expect(rule('.ballot-card.is-selected')).toMatch(/border-color: var\(--b-navy\)/);
    expect(rule('.ballot-card.is-selected')).toMatch(/box-shadow: var\(--glow\)/);
    expect(rule('.ballot-card.is-selected')).toMatch(/background: var\(--b-selected\)/);
    expect(css).toMatch(/--b-navy: #12355B/); expect(css).toMatch(/--b-selected: #EEF3F9/);
    expect(css).toMatch(/--glow: 0 0 0 3px rgba\(18, 53, 91, \.18\)/);
  });
  it('the card: 16px radius, 24px 20px 20px select area, 12px gaps, 14px radio inset, 44px statement row', () => {
    expect(rule('.ballot-card')).toMatch(/border-radius: 16px/);
    expect(rule('.ballot-card-main')).toMatch(/gap: 12px; width: 100%; padding: 24px 20px 20px/);
    expect(rule('.ballot-cards')).toMatch(/gap: 12px/);
    expect(rule('.ballot-radio')).toMatch(/top: 14px; right: 14px; width: 24px; height: 24px/);
    expect(rule('.statement-link')).toMatch(/min-height: 44px/);
    expect(rule('.ballot-card-name')).toMatch(/font-size: 18px; line-height: 1.3/);
    expect(rule('.ballot-card-line')).toMatch(/font-size: 15px; line-height: 1.5/);
  });
  it('the compact card has a 52px photo and a two-line pledge', () => {
    expect(rule('.avatar-sm')).toMatch(/width: 52px; height: 52px/);
    expect(rule('.ballot-card.is-compact .ballot-card-line')).toMatch(/line-clamp: 2/);
  });
  it('the sheet: 20px top radius, 12px 20px 24px padding, 16px gap, 55% scrim, 40x4 handle, 22px heading, 52px and 48px buttons', () => {
    expect(rule('.ballot-sheet')).toMatch(/gap: 16px; padding: 12px 20px 24px; background: #fff; border-radius: 20px 20px 0 0/);
    expect(rule('.sheet-backdrop')).toMatch(/rgba\(15, 27, 45, \.55\)/);
    expect(rule('.sheet-handle')).toMatch(/width: 40px; height: 4px/);
    expect(css).toMatch(/--b-sheet-line: #C9D0DA/);
    expect(rule('.sheet-title')).toMatch(/font-size: 22px; font-weight: 700/);
    expect(rule('.confirm-choice')).toMatch(/background: var\(--b-selected\); border: 2px solid var\(--b-navy\); border-radius: 14px/);
    expect(rule('.ballot-sheet .confirm-warning')).toMatch(/padding: 12px 14px; border: 0; border-radius: 12px; background: #FFF6E5; color: #6B4200; font-size: 14px; font-weight: 400; line-height: 1.45/);
    expect(rule('.ballot-btn-primary')).toMatch(/min-height: 52px/);
    expect(rule('.ballot-btn-secondary')).toMatch(/min-height: 48px/);
    expect(rule('.ballot-btn')).toMatch(/border-radius: 12px[^}]*font: 600 16px/);
  });
  it('the receipt: 72px #E6F2EB check circle, 24px title, left-aligned box with a 17px/600 code', () => {
    expect(rule('.ballot-state-icon')).toMatch(/width: 72px; height: 72px/);
    expect(rule('.ballot-state-success .ballot-state-icon')).toMatch(/#E6F2EB; color: #1E6B43/);
    expect(rule('.ballot-state-title')).toMatch(/font-size: 24px; font-weight: 700/);
    expect(rule('.ballot-state')).toMatch(/gap: 16px[^}]*padding: 32px 28px/);
    expect(rule('.receipt-box')).toMatch(/padding: 14px 16px; background: var\(--b-page\); border: 1px solid var\(--b-hair\); border-radius: 12px; text-align: left/);
    expect(rule('.receipt-code')).toMatch(/font: 600 17px[^}]*letter-spacing: \.04em/);
    expect(rule('.receipt-label')).toMatch(/font-size: 13px/);
  });
  it('the top bar is white with a 1px #E3E7ED bottom border and 16px 20px padding while a ballot is showing', () => {
    expect(css).toMatch(/body:has\(\.ballot-screen\) \.topbar \{ background: #fff;[^}]*border-bottom: 1px solid var\(--b-hair\)/);
    expect(css).toMatch(/body:has\(\.ballot-screen\) \.topbar-in \{[^}]*padding: 16px 20px/);
  });
  it('the header block: 13px/600 uppercase step label, 24px/700 title, chips, 15px helper, footer', () => {
    expect(rule('.ballot-step')).toMatch(/font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: \.04em/);
    expect(rule('.ballot-title')).toMatch(/font-size: 24px; font-weight: 700; line-height: 1.25/);
    expect(rule('.ballot-chip')).toMatch(/gap: 8px; padding: 6px 10px[^}]*border: 1px solid var\(--b-line\)[^}]*color: #334155; font-size: 13px/);
    expect(rule('.ballot-intro')).toMatch(/font-size: 15px; line-height: 1\.5; color: var\(--b-secondary\)/);
    expect(rule('.ballot-footer')).toMatch(/padding: 12px 20px 20px[^}]*border-top: 1px solid var\(--b-hair\)/);
  });
  it('every class the ballot screens use has a rule', () => {
    const src = readFileSync(path.resolve(__dirname, 'pages/VoteBlocks.tsx'), 'utf8');
    const used = new Set([...src.matchAll(/className=\{?[`"']([^`"'{$]+)/g)].flatMap((m) => m[1].split(/\s+/)).filter((c) => (/^(ballot|avatar|receipt|sheet|statement|help|confirm|abstain|position)-/.test(c) || c === 'is-compact') && !c.endsWith('-')));   // 'ballot-state-' and 'avatar-' are built from a tone or size
    const missing = [...used].filter((c) => !new RegExp(`\\.${c}[\\s,.:{]`).test(css));
    expect(missing).toEqual([]);
  });
});

describe('every new ballot screen has no axe violations (WCAG 2.1 A and AA, plus best practice)', () => {
  it('the campaign home: a voted block with its receipt, an open block, and the progress line', async () => {
    table[URL_INFO] = info({ progress: { voted: 1, total: 2 } }, two);
    const { container } = page();
    await screen.findByRole('list', { name: 'Positions' });
    expect(await audit(container)).toEqual([]);
  });
  it('the choose step: large cards with a pledge, a withdrawn card, a selected card, the abstain line and the review button', async () => {
    table[URL_INFO] = info(); table[`GET ${URL_POS}`] = ballot();
    const user = userEvent.setup();
    const { container } = page();
    await screen.findByRole('button', { name: /^Alice/ });
    expect(await audit(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: /^Alice/ }));
    expect(await audit(container)).toEqual([]);
  });
  it('the choose step with many candidates: compact cards, the region filter and the region groups', async () => {
    table[URL_INFO] = info(); table[`GET ${URL_POS}`] = ballot([...many, ABSTAIN]);
    const { container } = page();
    await screen.findByLabelText('Region');
    expect(await audit(container)).toEqual([]);
  });
  it('the confirm sheet', async () => {
    table[URL_INFO] = info(); table[`GET ${URL_POS}`] = ballot();
    const user = userEvent.setup();
    const { container } = page();
    await user.click(await screen.findByRole('button', { name: /^Ben/ }));
    await user.click(screen.getByRole('button', { name: 'Review vote for Ben' }));
    await screen.findByRole('dialog');
    expect(await audit(container)).toEqual([]);
  });
  it('the statement sheet and the help sheet', async () => {
    table[URL_INFO] = info(); table[`GET ${URL_POS}`] = ballot();
    const user = userEvent.setup();
    const { container } = page();
    await user.click(await screen.findByRole('button', { name: 'Read full statement of Alice Amutenya' }));
    await screen.findByRole('dialog');
    expect(await audit(container)).toEqual([]);
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Help: how voting works' }));
    await screen.findByRole('dialog');
    expect(await audit(container)).toEqual([]);
  });
  it('the receipt screen', async () => {
    table[URL_INFO] = info(); table[`GET ${URL_POS}`] = ballot(); table[`POST ${URL_POS}`] = { recorded: true, receiptCode: CODE };
    const user = userEvent.setup();
    const { container } = page();
    await user.click(await screen.findByRole('button', { name: /^Ben/ }));
    await user.click(screen.getByRole('button', { name: 'Review vote for Ben' }));
    await user.click(screen.getByRole('button', { name: 'Submit my vote' }));
    await screen.findByRole('heading', { name: 'Your vote is in' });
    expect(await audit(container)).toEqual([]);
  });
  it('the "may not have been recorded" screen', async () => {
    table[URL_INFO] = info(); table[`GET ${URL_POS}`] = ballot();
    const user = userEvent.setup();
    const { container } = page();
    await user.click(await screen.findByRole('button', { name: /^Ben/ }));
    await user.click(screen.getByRole('button', { name: 'Review vote for Ben' }));
    statuses[`POST ${URL_POS}`] = 500; statuses[`GET ${URL_POS}`] = 500;   // the server cannot be asked either
    await user.click(screen.getByRole('button', { name: 'Submit my vote' }));
    await screen.findByRole('heading', { name: 'Your vote may not have been recorded' });
    expect(await audit(container)).toEqual([]);
  });
  it('already voted, not open yet, closed, and an invalid link', async () => {
    const states: [Record<string, unknown>, string][] = [
      [info({ voterState: 'already_voted' }, [{ id: 'p1', title: 'Finance Officer', description: null, seats: 1, voted: true, candidateCount: 2, receiptCode: CODE }]), "You've already voted"],
      [info({ voterState: 'not_open', opensAt: '2030-01-01T08:00:00Z' }), "Voting hasn't opened yet"],
      [info({ voterState: 'closed' }), 'Voting has closed'],
    ];
    for (const [i, heading] of states) {
      table[URL_INFO] = i;
      const { container, unmount } = page();
      await screen.findByRole('heading', { name: heading });
      expect(await audit(container)).toEqual([]);
      unmount();
    }
    delete table[URL_INFO]; statuses[URL_INFO] = 404;
    const { container } = page();
    await screen.findByRole('heading', { name: "This voting link isn't valid" });
    expect(await audit(container)).toEqual([]);
  });
  it('the new-campaign form with the results date, and the edit form', async () => {
    const a = render(<MemoryRouter><NewCampaign /></MemoryRouter>);
    expect(await audit(a.container)).toEqual([]);
    a.unmount();
    table[`GET /api/campaigns/${ID}`] = { id: ID, title: 'T', description: null, status: 'draft', opens_at: null, closes_at: null, results_release_at: null, eligibility: 'umoja', allow_abstain: false, allow_edits_after_start: false, quorum_percent: null, candidates: [], eligible_emails: [], turnout: 0, umoja_active_count: 0, my_role: 'owner' };
    const b = render(<MemoryRouter initialEntries={[`/admin/c/${ID}/edit`]}><Routes><Route path="/admin/c/:id/edit" element={<EditCampaign />} /></Routes></MemoryRouter>);
    await screen.findByLabelText(/^Results will be shared on/);
    expect(await audit(b.container)).toEqual([]);
  });
});

// ---- multi-position campaigns: choose-N ("Additional Members: choose exactly 2", 13 candidates) ------------------------------------------------------
describe('a position with several seats', () => {
  const thirteen = Array.from({ length: 13 }, (_, i) => cand(`n${i + 1}`, `Candidate ${i + 1}`, { regionId: i % 2 ? 'r1' : 'r2', region: i % 2 ? 'Erongo' : 'Khomas', pledge: `Pledge ${i + 1}` }));
  const members = (over: Record<string, unknown> = {}) => ballot([...thirteen, ABSTAIN], { position: { id: 'p1', title: 'Additional Members', description: null, seats: 2, ruleText: 'Must be from the HR Department' }, ...over });
  const one = (n: number) => screen.getByRole('button', { name: new RegExp(`^Candidate ${n}\\b`) }) as HTMLButtonElement;
  const open = () => { table[URL_INFO] = info({}, [{ id: 'p1', title: 'Additional Members', description: null, seats: 2, ruleText: 'Must be from the HR Department', voted: false, candidateCount: 13, receiptCode: null }]); table[`GET ${URL_POS}`] = members(); };

  it('says the rule up front: "Choose 2", the eligibility line, compact cards (13 > 6) and the region filter (13 > 8)', async () => {
    open(); page();
    await screen.findByRole('button', { name: /^Candidate 1\b/ });
    expect(screen.getByText('Step 1 of 2 · Choose 2')).toBeTruthy();
    expect(screen.getByText('Must be from the HR Department').closest('.rule-text')?.querySelector('svg')).toBeTruthy();   // with an info icon
    expect(screen.getByText("Pick exactly 2 candidates. You'll see your choices again before anything is submitted.")).toBeTruthy();
    expect(document.querySelectorAll('.ballot-card.is-compact')).toHaveLength(13);
    expect(screen.getByLabelText('Region')).toBeTruthy();
  });

  it('uses checkboxes: the footer counts "Select 2 candidates" -> "1 of 2 selected" -> "Review 2 votes"; at the limit the other cards are dimmed and disabled until one is unselected', async () => {
    open(); const user = userEvent.setup(); page();
    await screen.findByRole('button', { name: /^Candidate 1\b/ });
    expect(document.querySelectorAll('.ballot-radio.is-check')).toHaveLength(13);                       // square indicators, not radios
    expect((screen.getByRole('button', { name: 'Select 2 candidates' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(one(3));
    expect((screen.getByRole('button', { name: '1 of 2 selected' }) as HTMLButtonElement).disabled).toBe(true);
    expect(one(4).disabled).toBe(false);
    await user.click(one(9));
    expect((screen.getByRole('button', { name: 'Review 2 votes' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText("You've picked 2 of 2. Unselect one to change.")).toBeTruthy();
    expect(one(3).getAttribute('aria-pressed')).toBe('true'); expect(one(9).getAttribute('aria-pressed')).toBe('true');
    expect(one(4).disabled).toBe(true); expect(one(4).closest('.ballot-card')?.classList.contains('is-dimmed')).toBe(true);
    expect(one(3).disabled).toBe(false);                                                                // the picked ones stay clickable
    await user.click(one(4));                                                                           // a disabled card cannot be added
    expect(one(4).getAttribute('aria-pressed')).toBe('false');
    await user.click(one(3));                                                                           // unselect one: the limit is lifted
    expect(one(4).disabled).toBe(false);
    expect((screen.getByRole('button', { name: '1 of 2 selected' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("You've picked 2 of 2. Unselect one to change.")).toBeNull();
  });

  it('the confirm sheet lists every chosen candidate and sends exactly those ids in one request', async () => {
    open(); table[`POST ${URL_POS}`] = { recorded: true, receiptCode: CODE };
    const user = userEvent.setup(); page();
    await screen.findByRole('button', { name: /^Candidate 1\b/ });
    await user.click(one(9)); await user.click(one(3));
    await user.click(screen.getByRole('button', { name: 'Review 2 votes' }));
    const sheet = screen.getByRole('dialog', { name: 'Confirm your vote' });
    expect(within(sheet).getByText('Candidate 9')).toBeTruthy(); expect(within(sheet).getByText('Candidate 3')).toBeTruthy();
    expect(sheet.querySelectorAll('.confirm-choice')).toHaveLength(2);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
    await user.click(within(sheet).getByRole('button', { name: 'Submit my vote' }));
    await screen.findByText('Your vote is in');
    expect(calls.filter((c) => c.method === 'POST' && c.url === URL_POS)).toEqual([{ method: 'POST', url: URL_POS, body: { candidateIds: ['n9', 'n3'] } }]);
    expect(screen.getByText(CODE)).toBeTruthy();
    expect(screen.queryByText('Candidate 9')).toBeNull();                                               // the choices are not kept on screen
  });

  it('Abstain stays a separate option: choosing it clears the candidates', async () => {
    open(); table[`POST ${URL_POS}`] = { recorded: true, receiptCode: CODE };
    const user = userEvent.setup(); page();
    await screen.findByRole('button', { name: /^Candidate 1\b/ });
    await user.click(one(1)); await user.click(one(2));
    await user.click(screen.getByRole('button', { name: /^Abstain/ }));
    expect(one(1).getAttribute('aria-pressed')).toBe('false'); expect(one(2).disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Review: abstain' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Submit my vote' }));
    await screen.findByText('Your vote is in');
    expect(calls.find((c) => c.method === 'POST' && c.url === URL_POS)?.body).toEqual({ candidateIds: ['ab'] });
  });

  it('a one-seat position still sends a single candidateId and shows no checkboxes', async () => {
    table[URL_INFO] = info(); table[`GET ${URL_POS}`] = ballot(); table[`POST ${URL_POS}`] = { recorded: true, receiptCode: CODE };
    const user = userEvent.setup(); page();
    await user.click(await screen.findByRole('button', { name: /^Ben Basson/ }));
    await user.click(screen.getByRole('button', { name: 'Review vote for Ben' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Submit my vote' }));
    await screen.findByText('Your vote is in');
    expect(calls.find((c) => c.method === 'POST' && c.url === URL_POS)?.body).toEqual({ candidateId: 'c2' });
    expect(document.querySelector('.ballot-radio.is-check')).toBeNull();
  });

  it('the campaign home shows the eligibility line and "Choose 2" on the position block', async () => {
    table[URL_INFO] = info({}, [
      { id: 'p1', title: 'Additional Members', description: null, seats: 2, ruleText: 'Must be from the HR Department', voted: false, candidateCount: 13, receiptCode: null },
      { id: 'p2', title: 'Secretary', description: null, seats: 1, ruleText: null, voted: false, candidateCount: 3, receiptCode: null }]);
    page();
    await screen.findByText('Must be from the HR Department');
    expect(screen.getByText('Choose 2')).toBeTruthy();
    expect(screen.getAllByText(/^Choose \d/)).toHaveLength(1);                                          // the one-seat block says nothing extra
  });

  it('the stylesheet: a 6px-radius square indicator, dimmed cards, the 13px #4A5565 eligibility line', () => {
    const css = readFileSync(path.resolve(__dirname, 'styles.css'), 'utf8');
    const rule = (selector: string) => {
      const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`).exec(css);
      if (!m) throw new Error(`no rule for ${selector}`);
      return m[1];
    };
    expect(rule('.ballot-radio.is-check')).toMatch(/border-radius: 6px/);
    expect(rule('.is-selected .ballot-radio.is-check')).toMatch(/background: var\(--b-navy\)/);
    expect(rule('.ballot-card.is-dimmed')).toMatch(/opacity: \.55/);
    expect(rule('.rule-text')).toMatch(/font-size: 13px[^}]*color: var\(--b-secondary\)/);
  });

  it('has no axe violations: the choose step at the limit (dimmed cards) and the confirm sheet listing two candidates', async () => {
    open(); const user = userEvent.setup(); const { container } = page();
    await screen.findByRole('button', { name: /^Candidate 1\b/ });
    await user.click(one(3)); await user.click(one(9));
    expect(await audit(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Review 2 votes' }));
    expect(await audit(document.body)).toEqual([]);
  });
});
