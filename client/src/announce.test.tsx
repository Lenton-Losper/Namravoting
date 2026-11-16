// Results privacy: voters never see results. "Announce winners" (admin), the announcement (voters who voted), My votes (Closed + receipt codes).
import axe from 'axe-core';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CampaignPage } from './pages/admin/CampaignPage';
import { MyVotes } from './pages/MyVotes';
import { NoticeList } from './ui';
import { resetCsrf } from './api';

const ID = '50a77f0b-87bd-4f3f-b4fb-6833a94a1086';
const TEXT = 'Result: Quarterly vote\n\nVoting has closed. The winners are:\n- Chair: Ann\n- Members: Ben, Cy\n\nThank you to everyone who voted.\nNamRA Voting';
const detail = (over: Record<string, unknown> = {}) => ({
  id: ID, title: 'Quarterly vote', description: null, status: 'closed', opens_at: null, closes_at: null, eligibility: 'all', winners_announced_at: null, share_token: 'x'.repeat(32),
  share_url: 'http://localhost/v/x', turnout: 2, eligible_emails: [], umoja_active_count: 0, allow_edits_after_start: false, edited_after_start: [], my_role: 'owner',
  candidates: [{ id: 'c1', name: 'Ann', bio: null, photo_url: null }, { id: 'c2', name: 'Ben', bio: null, photo_url: null }], ...over,
});
const results = () => ({ status: 'closed', winners_announced_at: null, candidates: [{ id: 'c1', name: 'Ann', votes: 2 }, { id: 'c2', name: 'Ben', votes: 0 }], turnout: { votes: 2, eligible: 4 },
  tie: null, runoff: { round: 0, max: 2, next: null, parent: null, can_start: false }, quorum: null, publication: null, notices: [] });
const preview = (over: Record<string, unknown> = {}) => ({
  available: true, announced: null, text: TEXT, blocks: [], below_quorum: null,
  positions: [{ id: 'p1', title: 'Chair', seats: 1, winners: ['Ann'], tie: null }, { id: 'p2', title: 'Members', seats: 2, winners: ['Ben', 'Cy'], tie: null }],
  email: { available: false, reason: 'Not available yet: it needs IT to grant the app the Mail.Send permission, and the app to sign in through Microsoft (AUTH_MODE=entra).' }, ...over,
});

let calls: { method: string; url: string; body: unknown }[] = [];
let table: Record<string, unknown> = {};
beforeEach(() => {
  calls = []; table = {}; resetCsrf(); sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined });
    const status = method === 'POST' && url.endsWith('/announce-winners') ? 201 : 200;
    return new Response(JSON.stringify(url === '/api/csrf' ? { token: 't' } : table[`${method} ${url}`] ?? {}), { status, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function adminResults(pv: object) {
  table[`GET /api/campaigns/${ID}`] = detail(); table[`GET /api/campaigns/${ID}/results`] = results(); table[`GET /api/campaigns/${ID}/announcement`] = pv;
  const user = userEvent.setup();
  const r = render(<MemoryRouter initialEntries={[`/admin/c/${ID}`]}><Routes><Route path="/admin/c/:id" element={<CampaignPage />} /></Routes></MemoryRouter>);
  await user.click(await screen.findByRole('tab', { name: /Results/ }));
  const panel = await screen.findByRole('region', { name: 'Announce winners' });
  return { user, panel, container: r.container };
}
async function audit(container: HTMLElement) {
  const r = await axe.run(container, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }, rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  return r.violations.map((v) => `${v.id}: ${v.help}`);
}

describe('Announce winners (admin)', () => {
  it('lists the winners by name, asks before announcing, announces once with one request, then shows it as announced', async () => {
    const { user, panel } = await adminResults(preview());
    expect(within(panel).getByText('Ann')).toBeTruthy(); expect(within(panel).getByText('Ben, Cy')).toBeTruthy();
    expect(panel.textContent).not.toMatch(/\d+ votes?|turnout|%/i);                                     // names only
    await user.click(within(panel).getByRole('button', { name: 'Announce winners' }));
    const dlg = await screen.findByRole('dialog', { name: 'Announce the winners?' });
    expect(dlg.textContent).toContain('- Members: Ben, Cy');                                            // the exact text that will be announced
    expect(calls.some((c) => c.url.endsWith('/announce-winners'))).toBe(false);                         // nothing sent until confirmed
    table[`GET /api/campaigns/${ID}/announcement`] = preview({ announced: { at: '2030-05-01T08:00:00Z', by: 'Olivia Owner' }, blocks: [{ code: 'already_announced', message: 'The winners have already been announced' }] });
    await user.click(within(dlg).getByRole('button', { name: 'Announce winners' }));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/announce-winners'))).toHaveLength(1));
    expect(calls.find((c) => c.url.endsWith('/announce-winners'))?.body).toEqual({});
    expect(await within(panel).findByText(/Olivia Owner announced the winners on 1 May 2030/)).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Announce winners' })).toBeNull();               // one time: no button any more
    expect(screen.queryByRole('button', { name: /Publish results/ })).toBeNull();
    expect(screen.queryByLabelText(/Publish automatically/)).toBeNull();                               // no scheduled publishing either
  });

  it('a TIED position blocks it: "Tied: create a run-off", the button and the copy text are disabled', async () => {
    const { panel } = await adminResults(preview({
      text: '', blocks: [{ code: 'tied', message: 'Tied: create a run-off', positions: ['Members'] }],
      positions: [{ id: 'p1', title: 'Chair', seats: 1, winners: ['Ann'], tie: null }, { id: 'p2', title: 'Members', seats: 2, winners: [], tie: ['Ben', 'Cy'] }] }));
    expect(within(panel).getAllByRole('alert')[0].textContent).toContain('Tied: create a run-off');
    expect(within(panel).getByText(/Tied: Ben and Cy/)).toBeTruthy();
    expect((within(panel).getByRole('button', { name: 'Announce winners' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(panel).getByRole('button', { name: 'Copy announcement text' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a result that no longer matches its seal blocks it, with the reason', async () => {
    const { panel } = await adminResults(preview({ blocks: [{ code: 'integrity_failed', message: 'The result no longer matches what was sealed when the campaign closed.' }] }));
    expect(within(panel).getByRole('alert').textContent).toContain('no longer matches what was sealed');
    expect((within(panel).getByRole('button', { name: 'Announce winners' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('below the quorum it asks again and sends the acknowledgement', async () => {
    const { user, panel } = await adminResults(preview({ below_quorum: { votes: 2, needed: 3, percent: 75 } }));
    await user.click(within(panel).getByRole('button', { name: 'Announce winners' }));
    const dlg = await screen.findByRole('dialog', { name: 'Announce below the quorum?' });
    expect(dlg.textContent).toContain('Only 2 of the 3 votes needed');
    await user.click(within(dlg).getByRole('button', { name: 'Announce anyway' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/announce-winners'))?.body).toEqual({ acknowledge_below_quorum: true }));
  });

  it('"Copy announcement text" copies the names-only text for WhatsApp / Teams', async () => {
    const { user, panel } = await adminResults(preview());
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });   // after userEvent.setup(), which installs its own
    await user.click(within(panel).getByRole('button', { name: 'Copy announcement text' }));
    expect(writeText).toHaveBeenCalledWith(TEXT);
    expect(await within(panel).findByRole('button', { name: 'Copied' })).toBeTruthy();
    expect(TEXT).not.toMatch(/\d+ votes?|turnout|%/i);
  });

  it('emailing the voters is a disabled stub that says why', async () => {
    const { panel } = await adminResults(preview());
    const box = within(panel).getByLabelText(/Also email everyone who voted/) as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(box.getAttribute('aria-describedby')).toBeTruthy();
    expect(panel.textContent).toContain('needs IT to grant the app the Mail.Send permission');
  });

  it('has no axe violations (ready, tied, announced)', async () => {
    const { container } = await adminResults(preview());
    expect(await audit(container)).toEqual([]);
    cleanup();
    const t = await adminResults(preview({ text: '', blocks: [{ code: 'tied', message: 'Tied: create a run-off', positions: ['Members'] }], positions: [{ id: 'p2', title: 'Members', seats: 2, winners: [], tie: ['Ben', 'Cy'] }] }));
    expect(await audit(t.container)).toEqual([]);
  });
});

describe('My votes and notices for voters', () => {
  const item = (over: Record<string, unknown>) => ({ shareToken: 't'.repeat(32), title: 'Quarterly vote', description: null, closesAt: '2030-01-01T10:00:00Z', opensAt: null, voterState: 'closed', positions: { voted: 2, total: 2 }, ...over });

  it('lists a closed campaign the voter voted in as "Closed" with their receipt codes, and never as "Results"', async () => {
    table['GET /api/vote'] = { campaigns: [item({ receipts: [{ position: 'Chair', code: 'UV-AAAA-BBBB' }, { position: 'Members', code: 'UV-CCCC-DDDD' }] }), item({ shareToken: 'u'.repeat(32), title: 'Open one', voterState: 'can_vote' })] };
    render(<MemoryRouter><MyVotes /></MemoryRouter>);
    const closed = (await screen.findByText('Quarterly vote')).closest('a') as HTMLElement;
    expect(within(closed).getByText('Closed')).toBeTruthy();
    expect(closed.textContent).toContain('Chair: UV-AAAA-BBBB'); expect(closed.textContent).toContain('Members: UV-CCCC-DDDD');
    expect(screen.queryByText('Results')).toBeNull();
  });

  it('one position: "Receipt UV-…" without the position name', async () => {
    table['GET /api/vote'] = { campaigns: [item({ positions: { voted: 1, total: 1 }, receipts: [{ position: 'Chair', code: 'UV-AAAA-BBBB' }] })] };
    render(<MemoryRouter><MyVotes /></MemoryRouter>);
    expect((await screen.findByText(/Receipt UV-AAAA-BBBB/)).textContent).toBe('Receipt UV-AAAA-BBBB');
  });

  it('a reset notice shows the reason and time, and without a count says so plainly (a voter is never told how many votes there were)', () => {
    render(<NoticeList notices={[{ kind: 'reset', at: '2030-01-01T10:00:00Z', by: 'Olivia', reason: 'A mistake in the list' }]} />);
    expect(screen.getByText(/reset: all votes were cleared/)).toBeTruthy();
    expect(screen.queryByText(/\d+ votes? cleared/)).toBeNull();
  });
});

describe('no voter screen can ask for results (guard on the source)', () => {
  const src = (f: string) => readFileSync(path.resolve(__dirname, f), 'utf8');
  it('Vote.tsx, VoteBlocks.tsx and MyVotes.tsx never call a results route and never read a published flag', () => {
    for (const f of ['pages/Vote.tsx', 'pages/VoteBlocks.tsx', 'pages/MyVotes.tsx']) {
      const code = src(f);
      expect(code, `${f} calls a results route`).not.toMatch(/api\/vote\/[^'"`]*\/results/);
      expect(code, `${f} reads resultsPublished`).not.toMatch(/resultsPublished|results_published/);
      expect(code, `${f} uses PositionResults / ResultsChart`).not.toMatch(/PositionResults|ResultsChart/);
    }
  });
});
