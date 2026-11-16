// Multi-position campaigns in the browser: the voter's position blocks and region-filtered ballot, the candidate's nomination page, and
// the admin's position blocks (approve / reject / invite / regions), plus WCAG checks (axe) on each new screen.
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { App } from './App';
import { AuthProvider } from './auth';
import { resetCsrf } from './api';
import { VotePage } from './pages/Vote';
import { NominatePage } from './pages/Nominate';
import { PositionResults } from './ui';

const ID = '50a77f0b-87bd-4f3f-b4fb-6833a94a1086';
const TOKEN = 'a'.repeat(32);
const NTOKEN = 'n'.repeat(32);
const PID = ['p1', 'p2', 'p3'];
const ADMIN = { oid: 'o1', email: 'admin@x.test', displayName: 'Olivia Owner', roles: ['CampaignAdmin'] };
const STAFF = { oid: 's1', email: 'staff@x.test', displayName: 'Sam Staff', roles: [] };

let calls: { method: string; url: string; body: unknown }[] = [];
let table: Record<string, unknown | (() => unknown)> = {};
let statuses: Record<string, number> = {};
beforeEach(() => {
  calls = []; table = {}; statuses = {}; resetCsrf(); sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
    const hit = table[`${method} ${url}`];
    const body = url === '/api/csrf' ? { token: 't' } : typeof hit === 'function' ? (hit as () => unknown)() : hit ?? {};
    return new Response(JSON.stringify(body), { status: statuses[`${method} ${url}`] ?? 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const session = (user: object | null) => { table['GET /api/session'] = { user, authMode: 'entra', observing: 0, notices: [] }; };
async function audit(container: HTMLElement) {
  const r = await axe.run(container, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }, rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.slice(0, 4).map((n) => n.target.join(' ')).join('\n    ')}`);
}
const app = (path: string) => render(<MemoryRouter initialEntries={[path]}><AuthProvider><App /></AuthProvider></MemoryRouter>);

// ---- voter ------------------------------------------------------------------------------------------------------------------------

const REGIONS = [{ id: 'r1', name: 'Erongo' }, { id: 'r2', name: 'Khomas' }, { id: 'r3', name: 'Zambezi' }];
const block = (i: number, title: string, voted: boolean, candidateCount = 3, receiptCode: string | null = null) => ({ id: PID[i], title, description: null, seats: 1, voted, candidateCount, receiptCode });
const campaignInfo = (voted: boolean[], over: Record<string, unknown> = {}) => ({
  title: 'Umoja Committee 2026', description: 'Elect your committee', opensAt: null, closesAt: '2030-01-01T10:00:00Z', resultsReleaseAt: '2030-01-05T08:00:00Z', groupByRegion: false, resultsPublished: false, voterState: voted.every(Boolean) ? 'already_voted' : 'can_vote',
  notices: [], candidates: [], regions: REGIONS, progress: { voted: voted.filter(Boolean).length, total: voted.length },
  positions: [block(0, 'Press Secretary', voted[0], 3, voted[0] ? 'UV-AB23-CD45' : null), block(1, 'Finance Officer', voted[1], 2), block(2, 'Treasurer', voted[2], 2)], ...over,
});
const cand = (id: string, name: string, regionId: string | null, region: string | null, extra: Record<string, unknown> = {}) => ({ id, name, bio: `${name} bio`, pledge: null, photoUrl: null, isAbstain: false, withdrawn: false, positionId: PID[0], regionId, region, ...extra });
const ballot = (extra: Record<string, unknown>[] = [], over: Record<string, unknown> = {}) => ({
  position: { id: PID[0], title: 'Press Secretary', description: null }, campaign: { title: 'Umoja Committee 2026', closesAt: null }, groupByRegion: false, voterState: 'can_vote', regions: REGIONS, progress: { voted: 0, total: 3 },
  candidates: [cand('c1', 'Alice', 'r2', 'Khomas'), cand('c2', 'Bob', 'r1', 'Erongo'), cand('c3', 'Chipo', 'r3', 'Zambezi'), cand('c4', 'Dan', 'r2', 'Khomas'), ...extra], ...over,
});
/** The names on the ballot's choices in page order: the candidate cards, then the abstain line. */
const names = () => [...document.querySelectorAll('.ballot-card-main, .abstain-option')].map((b) => b.querySelector('strong')?.textContent);
const vote = (path = `/v/${TOKEN}`) => render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/v/:shareToken" element={<VotePage />} /></Routes></MemoryRouter>);

describe("the voter's campaign page", () => {
  it('shows a block per position and the progress, greys out a done block with a "Voted" tick and its receipt, and never opens it again', async () => {
    table[`GET /api/vote/${TOKEN}`] = campaignInfo([true, false, false]);
    const user = userEvent.setup();
    vote();
    expect(await screen.findByRole('heading', { name: 'Choose a position to vote in' })).toBeTruthy();
    expect(screen.getByText('Umoja Committee 2026')).toBeTruthy();
    expect(screen.getByText(/1 of 3/).parentElement?.textContent).toBe('1 of 3 positions voted');
    const grid = screen.getByRole('list', { name: 'Positions' });
    const blocks = within(grid).getAllByRole('button');
    expect(blocks.map((b) => b.getAttribute('aria-label'))).toEqual(['Press Secretary: voted, receipt UV-AB23-CD45', 'Finance Officer: 2 candidates, not voted yet', 'Treasurer: 2 candidates, not voted yet']);
    expect((blocks[0] as HTMLButtonElement).disabled).toBe(true);
    expect(blocks[0].textContent).toContain('Voted');
    expect(blocks[0].textContent).toContain('Receipt UV-AB23-CD45');
    expect(blocks[0].className).toContain('position-voted');
    expect((blocks[1] as HTMLButtonElement).disabled).toBe(false);
    await user.click(blocks[0]);                                                                       // a greyed-out block does nothing
    expect(calls.some((c) => c.url.includes('/positions/'))).toBe(false);
  });

  it('opens a position, votes with a choice, a confirmation sheet and a receipt, and comes back to the blocks with the block done', async () => {
    table[`GET /api/vote/${TOKEN}`] = campaignInfo([false, false, false]);
    table[`GET /api/vote/${TOKEN}/positions/p1`] = ballot([cand('ab', 'Abstain (none of the above)', null, null, { isAbstain: true })]);
    table[`POST /api/vote/${TOKEN}/positions/p1`] = { recorded: true, receiptCode: 'UV-7K3M-Q9TD' };
    const user = userEvent.setup();
    vote();
    await user.click(await screen.findByRole('button', { name: /Press Secretary/ }));
    // 4 candidates: no region filter and no region headings; the abstain line comes last, apart from the candidates
    await screen.findByRole('heading', { name: 'Press Secretary' });
    expect(screen.queryByLabelText('Region')).toBeNull();
    expect(names()).toEqual(['Alice', 'Bob', 'Chipo', 'Dan', 'Abstain']);
    expect((screen.getByRole('button', { name: 'Review vote' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: /^Chipo/ }));
    await user.click(screen.getByRole('button', { name: 'Review vote for Chipo' }));
    const sheet = await screen.findByRole('dialog', { name: 'Confirm your vote' });
    expect(within(sheet).getByText('Chipo')).toBeTruthy();
    expect(within(sheet).getByText(/Once you submit, your vote can't be changed/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url.includes('/positions/'))).toBe(false);       // nothing is sent before "Submit my vote"
    table[`GET /api/vote/${TOKEN}`] = campaignInfo([true, false, false]);
    await user.click(within(sheet).getByRole('button', { name: 'Submit my vote' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: `/api/vote/${TOKEN}/positions/p1`, body: { candidateId: 'c3' } }));
    // the receipt: a code and the results date, and never the candidate
    expect(await screen.findByRole('heading', { name: 'Your vote is in' })).toBeTruthy();
    expect(screen.getByText('UV-7K3M-Q9TD')).toBeTruthy();
    expect(screen.getByText(/Winners will be announced on/)).toBeTruthy();
    expect(screen.queryByText(/Chipo/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    // back on the blocks, the block is done and the progress moved on
    expect(await screen.findByRole('button', { name: 'Press Secretary: voted, receipt UV-AB23-CD45' })).toBeTruthy();
    expect(screen.getByText(/1 of 3/)).toBeTruthy();
  });

  it('with many candidates, or when results are grouped by region, there is a region filter that only lists regions with candidates', async () => {
    table[`GET /api/vote/${TOKEN}`] = campaignInfo([false, false, false]);
    table[`GET /api/vote/${TOKEN}/positions/p1`] = ballot([cand('ab', 'Abstain (none of the above)', null, null, { isAbstain: true })], { groupByRegion: true });
    const user = userEvent.setup();
    vote();
    await user.click(await screen.findByRole('button', { name: /Press Secretary/ }));
    const select = await screen.findByLabelText('Region');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['All regions', 'Erongo', 'Khomas', 'Zambezi']);
    // grouped by region in the campaign's region order, with the abstain line last and outside any region
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent).filter((t) => /\(\d+\)/.test(t ?? ''));
    expect(headings).toEqual(['Erongo (1)', 'Khomas (2)', 'Zambezi (1)']);
    expect(names()).toEqual(['Bob', 'Alice', 'Dan', 'Chipo', 'Abstain']);
    expect(screen.getByText('4 candidates')).toBeTruthy();

    // filter: only Khomas candidates (the abstain line belongs to no region)
    await user.selectOptions(select, 'r2');
    expect(names()).toEqual(['Alice', 'Dan', 'Abstain']);
    expect(screen.getByText('Showing 2 of 4 candidates')).toBeTruthy();

    // a choice hidden by the filter is dropped, so nobody confirms a candidate they cannot see
    await user.click(screen.getByRole('button', { name: /^Alice/ }));
    expect(screen.getByRole('button', { name: /^Alice/ }).getAttribute('aria-pressed')).toBe('true');
    await user.selectOptions(select, 'r3');
    expect((screen.getByRole('button', { name: 'Review vote' }) as HTMLButtonElement).disabled).toBe(true);
    await user.selectOptions(select, '');
    expect(names()).toEqual(['Bob', 'Alice', 'Dan', 'Chipo', 'Abstain']);
  });

  it('a 409 (already voted here, or closed) sends the voter back to the list instead of showing the ballot', async () => {
    table[`GET /api/vote/${TOKEN}`] = campaignInfo([false, false, false]);
    statuses[`GET /api/vote/${TOKEN}/positions/p1`] = 409;
    table[`GET /api/vote/${TOKEN}/positions/p1`] = { error: 'You have already voted in this position', code: 'already_voted' };
    const user = userEvent.setup();
    vote();
    await user.click(await screen.findByRole('button', { name: /Press Secretary/ }));
    expect(await screen.findByRole('list', { name: 'Positions' })).toBeTruthy();
    expect(screen.queryByLabelText('Region')).toBeNull();
  });

  it('when every position is voted the page says so; after the close a voter sees only the announced winners, by name, and never calls the results route', async () => {
    table[`GET /api/vote/${TOKEN}`] = { ...campaignInfo([true, true, true]), voterState: 'closed', announcement: { at: '2030-01-06T08:00:00Z', text: 'x', positions: [{ title: 'Press Secretary', winners: ['Alice'] }, { title: 'Finance Officer', winners: ['Dana', 'Esau'] }] } };
    vote();
    const card = await screen.findByRole('region', { name: 'Winners' });
    expect(within(card).getByText(/Press Secretary/).parentElement?.textContent).toContain('Alice');
    expect(within(card).getByText(/Finance Officer/).parentElement?.textContent).toContain('Dana, Esau');
    expect(card.textContent).not.toMatch(/\d+ votes?|turnout|%/i);                                    // names only: no counts
    expect(calls.some((c) => c.url.includes('/results'))).toBe(false);
  });
});

describe('results per position', () => {
  const r = (group: boolean) => ({
    turnout: { votes: 6, eligible: 20 }, quorum: null, group_by_region: group,
    positions: [
      { id: 'p1', title: 'Press Secretary', turnout: { votes: 6 }, tie: null, winners: [{ id: 'a', name: 'Alice', votes: 4 }], candidates: [{ id: 'a', name: 'Alice', votes: 4, region: 'Khomas' }, { id: 'b', name: 'Bob', votes: 1, region: 'Erongo' }, { id: 'x', name: 'Abstain', votes: 1, is_abstain: true }] },
      { id: 'p2', title: 'Finance Officer', turnout: { votes: 4 }, tie: { names: ['Dana', 'Esau'], votes: 2 }, winners: [], candidates: [{ id: 'd', name: 'Dana', votes: 2, region: 'Oshana' }, { id: 'e', name: 'Esau', votes: 2, region: null }] },
    ],
  });
  it('shows each position\'s own turnout, winner or tie, and the campaign turnout of members who voted at least once', () => {
    render(<PositionResults r={r(false)} />);
    expect(screen.getByText('Members who voted in at least one position')).toBeTruthy();
    const press = screen.getByRole('region', { name: 'Press Secretary' });
    expect(within(press).getByText(/6 members voted in this position/)).toBeTruthy();
    expect(within(press).getByText(/Winner:/).parentElement?.textContent).toContain('Alice');
    expect(within(press).getByText(/Abstentions \(not a candidate, never a winner\): 1/)).toBeTruthy();
    expect(within(press).getAllByRole('progressbar')).toHaveLength(2);                     // abstain is not a bar
    expect(within(screen.getByRole('region', { name: 'Finance Officer' })).getByText(/Tie for first place:/).parentElement?.textContent).toContain('Dana and Esau');
    expect(screen.queryByRole('heading', { level: 4 })).toBeNull();                        // not grouped
  });
  it('groups candidates under their region when the admin chose that (no region last)', () => {
    render(<PositionResults r={r(true)} />);
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(['Erongo', 'Khomas', 'Oshana', 'No region']);
  });
  it('while the campaign is open a position shows its turnout only, never a count', () => {
    render(<PositionResults r={{ turnout: { votes: 2, eligible: null }, positions: [{ id: 'p1', title: 'Treasurer', candidates: null, turnout: { votes: 2 } }] }} />);
    expect(screen.getByText(/2 members voted in this position/)).toBeTruthy();
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
    expect(screen.queryByText(/Winner/)).toBeNull();
  });
});

// ---- candidate --------------------------------------------------------------------------------------------------------------------

const nominateInfo = (over: Record<string, unknown> = {}) => ({
  campaign: { title: 'Umoja Committee 2026' }, position: { id: 'p1', title: 'Press Secretary', description: 'Speaks for the committee' }, state: 'open', closesAt: null,
  regions: REGIONS, defaultName: 'Sam Staff', canEdit: true, profile: null, ...over,
});
const nominate = () => render(<MemoryRouter initialEntries={[`/n/${NTOKEN}`]}><Routes><Route path="/n/:token" element={<NominatePage />} /></Routes></MemoryRouter>);

describe('the nomination page', () => {
  it('pre-fills the name from the account, needs a region, and submits the profile with the photo field', async () => {
    table[`GET /api/nominate/${NTOKEN}`] = nominateInfo();
    const user = userEvent.setup();
    nominate();
    expect(await screen.findByRole('heading', { name: 'Stand for Press Secretary' })).toBeTruthy();
    const name = screen.getByLabelText(/^Name/) as HTMLInputElement;
    expect(name.value).toBe('Sam Staff');
    const submit = screen.getByRole('button', { name: 'Submit my profile' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);                                                               // no region yet
    await user.clear(name); await user.type(name, 'Samuel Staff');
    await user.selectOptions(screen.getByLabelText(/^Region/), 'r2');
    await user.type(screen.getByLabelText(/Short bio/), 'Ten years in customs.');
    await user.upload(screen.getByLabelText(/Photo/), new File([new Uint8Array([1, 2, 3])], 'me.png', { type: 'image/png' }));
    table[`GET /api/nominate/${NTOKEN}`] = nominateInfo({ profile: { id: 'k1', name: 'Samuel Staff', bio: 'Ten years in customs.', regionId: 'r2', status: 'submitted', reviewReason: null, photoUrl: '/api/photos/k1' } });
    await user.click(submit);
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT')).toBeTruthy());
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.url).toBe(`/api/nominate/${NTOKEN}`);
    const fd = put.body as FormData;
    expect([fd.get('name'), fd.get('region_id'), fd.get('bio')]).toEqual(['Samuel Staff', 'r2', 'Ten years in customs.']);
    expect((fd.get('photo') as File).name).toBe('me.png');
    expect(await screen.findByText(/Submitted: waiting for the administrator/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();                       // can still be edited
  });

  it('shows a rejection with its reason and lets the candidate submit again', async () => {
    table[`GET /api/nominate/${NTOKEN}`] = nominateInfo({ profile: { id: 'k1', name: 'Sam', bio: null, regionId: 'r1', status: 'rejected', reviewReason: 'The bio is not suitable.', photoUrl: null } });
    nominate();
    expect(await screen.findByText('Not approved')).toBeTruthy();
    expect(screen.getByText(/The bio is not suitable\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Submit again' })).toBeTruthy();
  });

  it('is read-only once approved (no form), and says nominations are closed once voting has started', async () => {
    table[`GET /api/nominate/${NTOKEN}`] = nominateInfo({ canEdit: false, profile: { id: 'k1', name: 'Sam Staff', bio: 'Hi', regionId: 'r1', status: 'approved', reviewReason: null, photoUrl: null } });
    nominate();
    expect(await screen.findByText('Approved: you are on the ballot')).toBeTruthy();
    expect(screen.queryByLabelText(/^Name/)).toBeNull();
    cleanup();
    table[`GET /api/nominate/${NTOKEN}`] = nominateInfo({ canEdit: false, state: 'ended' });
    nominate();
    expect(await screen.findByRole('heading', { name: 'Nominations are closed' })).toBeTruthy();
    expect(screen.getByText('Nominations closed when voting started.')).toBeTruthy();
    expect(screen.queryByLabelText(/^Name/)).toBeNull();
  });

  it('withdraws after a confirmation', async () => {
    table[`GET /api/nominate/${NTOKEN}`] = nominateInfo({ profile: { id: 'k1', name: 'Sam', bio: null, regionId: 'r1', status: 'submitted', reviewReason: null, photoUrl: null } });
    const user = userEvent.setup();
    nominate();
    await user.click(await screen.findByRole('button', { name: 'Withdraw' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === `/api/nominate/${NTOKEN}/withdraw`)).toBe(true));
  });

  it('answers an unknown link and an ineligible account with a clear card', async () => {
    statuses[`GET /api/nominate/${NTOKEN}`] = 404; table[`GET /api/nominate/${NTOKEN}`] = { error: 'Not found' };
    nominate();
    expect(await screen.findByRole('heading', { name: "This nomination link isn't valid" })).toBeTruthy();
    cleanup();
    statuses[`GET /api/nominate/${NTOKEN}`] = 403; table[`GET /api/nominate/${NTOKEN}`] = { error: 'Nominations for this vote are for Umoja members only', code: 'not_member' };
    nominate();
    expect(await screen.findByText('Nominations for this vote are for Umoja members only')).toBeTruthy();
  });

  it('a visitor who is not signed in is sent to sign in and brought back to the link', async () => {
    session(null);
    app(`/n/${NTOKEN}`);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Sign in with Microsoft' })).toBeTruthy());
  });
});

// ---- admin ------------------------------------------------------------------------------------------------------------------------

const adminPos = (i: number, title: string, over: Record<string, unknown> = {}) => ({
  id: PID[i], title, description: null, sort_order: i + 1, seats: 1, min_candidates: null, max_candidates: null, status: 'open', nomination_state: 'not_invited', invite_url: null, required: 2,
  counts: { approved: 2, submitted: 0, rejected: 0, withdrawn: 0, invited: 0 }, result: null, ...over,
});
const adminCampaign = (over: Record<string, unknown> = {}) => ({
  id: ID, title: 'Umoja Committee 2026', description: null, status: 'draft', opens_at: null, closes_at: null, eligibility: 'all', results_published: false, share_token: TOKEN,
  share_url: `http://localhost/v/${TOKEN}`, turnout: 0, eligible_emails: [], umoja_active_count: 0, allow_edits_after_start: false, allow_abstain: false, edited_after_start: [], my_role: 'owner',
  require_approval: false, publish_at: null, candidates: [], regions: REGIONS, nominations_close_at: null, nominate_eligibility: null, results_group_by_region: false,
  positions: [adminPos(0, 'Press Secretary', { counts: { approved: 2, submitted: 1, rejected: 0, withdrawn: 0, invited: 0 }, nomination_state: 'open', invite_url: `http://localhost/n/${NTOKEN}` }), adminPos(1, 'Finance Officer', { counts: { approved: 1, submitted: 0, rejected: 0, withdrawn: 0, invited: 0 } })],
  ...over,
});
const nominations = [
  { id: 'k1', name: 'Alice', bio: 'Finance', photo_url: null, status: 'approved', region_id: 'r2', region: 'Khomas', submitted_at: '2026-03-01T10:00:00Z', submitted_by: 'Alice A', submitted_by_email: 'alice@x.test', review_reason: null },
  { id: 'k2', name: 'Bob', bio: null, photo_url: null, status: 'submitted', region_id: 'r1', region: 'Erongo', submitted_at: '2026-03-02T10:00:00Z', submitted_by: 'Bob B', submitted_by_email: 'bob@x.test', review_reason: null },
];
const adminPage = () => { session(ADMIN); return app(`/admin/c/${ID}`); };

describe('the admin\'s position blocks', () => {
  it('shows a row per position with a Ready / Needs N more chip, the summary line, the review count and the nomination status; the Actions panel says what blocks the start, once', async () => {
    table[`GET /api/campaigns/${ID}`] = adminCampaign();
    adminPage();
    const grid = await screen.findByRole('list', { name: 'Positions' });
    const press = within(grid).getByRole('article', { name: 'Press Secretary' });
    expect(within(press).getByText('Ready')).toBeTruthy();
    expect(within(press).getByText('2 of 2 approved · 1 winner')).toBeTruthy();
    expect(within(press).getByText('1 to review')).toBeTruthy();
    expect(within(press).getByText('Nominations open')).toBeTruthy();
    const fin = within(grid).getByRole('article', { name: 'Finance Officer' });
    expect(within(fin).getByText('Needs 1 more')).toBeTruthy();
    expect(within(fin).getByText('1 of 2 approved · 1 winner')).toBeTruthy();
    expect(within(fin).getByText('No nomination link yet')).toBeTruthy();
    expect(within(fin).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('1');
    expect((within(fin).getByRole('progressbar').firstElementChild as HTMLElement).style.width).toBe('50%');
    // "Ready to start?" is the one place the blocker is spelled out: a line per position
    const panel = screen.getByRole('complementary');
    expect(within(panel).getByRole('heading', { name: 'Ready to start?' })).toBeTruthy();
    expect(within(panel).getByText(/Press Secretary/).closest('li')?.textContent).toContain('2 candidates approved');
    expect(within(panel).getByText(/Finance Officer/).closest('li')?.textContent).toContain('needs 1 more approved');
    expect(screen.queryByText(/Still short/)).toBeNull();                                               // the three repeated warnings are gone
    expect(screen.queryByText('Needs at least 2 approved')).toBeNull();
    expect((screen.getByRole('button', { name: 'Start voting' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Starting locks the campaign: details, positions, candidates and voters can't be changed after.")).toBeTruthy();
  });

  it('lets the start through once every position has enough approved candidates', async () => {
    table[`GET /api/campaigns/${ID}`] = adminCampaign({ positions: [adminPos(0, 'Press Secretary'), adminPos(1, 'Finance Officer')] });
    adminPage();
    await screen.findByRole('list', { name: 'Positions' });
    expect((screen.getByRole('button', { name: 'Start voting' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('adds, edits, reorders and removes positions', async () => {
    table[`GET /api/campaigns/${ID}`] = adminCampaign();
    const user = userEvent.setup();
    adminPage();
    await screen.findByRole('list', { name: 'Positions' });
    await user.click(screen.getByRole('button', { name: '+ Add a position' }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText(/^Title/), 'Treasurer');
    await user.click(within(dlg).getByRole('button', { name: 'Add position' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === `/api/campaigns/${ID}/positions`)?.body).toMatchObject({ title: 'Treasurer', seats: 1, min_candidates: null, max_candidates: null }));

    // Press Secretary is first: its menu has no "Move up"; Finance Officer is last: no "Move down"
    await user.click(screen.getByRole('button', { name: 'More actions for Press Secretary' }));
    expect(screen.queryByRole('menuitem', { name: 'Move up' })).toBeNull();
    await user.click(screen.getByRole('menuitem', { name: 'Move down' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/positions/reorder'))?.body).toEqual({ ids: [PID[1], PID[0]] }));
    await user.click(screen.getByRole('button', { name: 'More actions for Finance Officer' }));
    expect(screen.queryByRole('menuitem', { name: 'Move down' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Move up' })).toBeTruthy();
    await user.click(screen.getByRole('menuitem', { name: 'Edit position' }));
    const edit = await screen.findByRole('dialog');
    await user.clear(within(edit).getByLabelText(/^Title/)); await user.type(within(edit).getByLabelText(/^Title/), 'Finance Lead');
    await user.click(within(edit).getByRole('button', { name: 'Save position' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH' && c.url === `/api/campaigns/${ID}/positions/${PID[1]}`)?.body).toMatchObject({ title: 'Finance Lead' }));

    await user.click(screen.getByRole('button', { name: 'More actions for Finance Officer' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove position…' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove position' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === `/api/campaigns/${ID}/positions/${PID[1]}`)).toBe(true));
  });

  it('reviews nominations: approve, and reject with a reason (the button waits for one)', async () => {
    table[`GET /api/campaigns/${ID}`] = adminCampaign();
    table[`GET /api/campaigns/${ID}/positions/p1/nominations`] = { nominations };
    const user = userEvent.setup();
    adminPage();
    await user.click((await screen.findAllByRole('button', { name: 'Manage candidates' }))[0]);
    const detail = await screen.findByRole('region', { name: 'Press Secretary details' });
    expect(await within(detail).findByText(/applied by Bob B \(bob@x\.test\)/)).toBeTruthy();
    expect(within(detail).getByText('Waiting for review')).toBeTruthy();
    expect(within(detail).queryByRole('button', { name: 'Approve Alice' })).toBeNull();                // already approved
    await user.click(within(detail).getByRole('button', { name: 'Approve Bob' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === `/api/campaigns/${ID}/candidates/k2/approve`)).toBe(true));

    await user.click(within(detail).getByRole('button', { name: 'Reject Bob' }));
    const dlg = await screen.findByRole('dialog');
    const confirm = within(dlg).getByRole('button', { name: 'Reject profile' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.type(within(dlg).getByLabelText(/^Reason/), 'Not a member of staff.');
    await user.click(confirm);
    await waitFor(() => expect(calls.find((c) => c.url === `/api/campaigns/${ID}/candidates/k2/reject`)?.body).toEqual({ reason: 'Not a member of staff.' }));
  });

  it('invites candidates: creates the link, shows it with its QR code, and can turn it off', async () => {
    table[`GET /api/campaigns/${ID}`] = adminCampaign();
    table[`GET /api/campaigns/${ID}/positions/p2/nominations`] = { nominations: [] };
    const user = userEvent.setup();
    adminPage();
    const buttons = await screen.findAllByRole('button', { name: 'Manage candidates' });
    await user.click(buttons[1]);
    await user.click(await screen.findByRole('button', { name: 'Invite candidates' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === `/api/campaigns/${ID}/positions/p2/invite`)).toBe(true));
    // the first position already has a link: its panel shows the link, Copy link and Download QR
    cleanup();
    adminPage();
    await user.click((await screen.findAllByRole('button', { name: 'Manage candidates' }))[0]);
    table[`GET /api/campaigns/${ID}/positions/p1/nominations`] = { nominations };
    const link = (await screen.findByLabelText('Share this nomination link')) as HTMLInputElement;
    expect(link.value).toBe(`http://localhost/n/${NTOKEN}`);
    expect(link.readOnly).toBe(true);
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Download QR/ }).getAttribute('href')).toBe(`/api/campaigns/${ID}/positions/p1/invite.png?download=1`);
    await user.click(screen.getByRole('button', { name: 'Turn the link off' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === `/api/campaigns/${ID}/positions/p1/invite`)).toBe(true));
  });

  it('shows turnout and the winner or tie on each block once the campaign has closed, and offers no editing', async () => {
    table[`GET /api/campaigns/${ID}`] = adminCampaign({
      status: 'closed', turnout: 9, positions: [
        adminPos(0, 'Press Secretary', { nomination_state: 'ended', result: { turnout: 9, winners: ['Alice'], tie: null } }),
        adminPos(1, 'Finance Officer', { nomination_state: 'ended', result: { turnout: 7, winners: [], tie: ['Dana', 'Esau'] } })],
    });
    table[`GET /api/campaigns/${ID}/results`] = { status: 'closed', results_published: false, turnout: { votes: 9, eligible: null }, candidates: [], positions: [] };
    adminPage();
    const grid = await screen.findByRole('list', { name: 'Positions' });
    expect(within(grid).getByText(/9 voted/).textContent).toContain('Winner: Alice');
    expect(within(grid).getByText(/7 voted/).textContent).toContain('Tie: Dana and Esau');
    expect(screen.queryByRole('button', { name: '+ Add a position' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remove Press Secretary' })).toBeNull();
    expect(within(grid).getAllByText('Nominations ended')).toHaveLength(2);
  });

  it('edits the regions, the nomination settings and the grouped-results choice on the Settings tab', async () => {
    table[`GET /api/campaigns/${ID}`] = adminCampaign();
    const user = userEvent.setup();
    adminPage();
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    expect(screen.getByText('Erongo')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Rename Erongo' }));
    const rn = screen.getByLabelText('Region name');
    await user.clear(rn); await user.type(rn, 'Walvis Bay Office');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH' && c.url === `/api/campaigns/${ID}/regions/r1`)?.body).toEqual({ name: 'Walvis Bay Office' }));
    await user.type(screen.getByLabelText('Add a region'), 'Ongwediva Office');
    await user.click(screen.getByRole('button', { name: 'Add region' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === `/api/campaigns/${ID}/regions`)?.body).toEqual({ name: 'Ongwediva Office' }));
    await user.click(screen.getByRole('button', { name: 'Remove Zambezi' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === `/api/campaigns/${ID}/regions/r3`)).toBe(true));

    await user.selectOptions(screen.getByLabelText(/Who can nominate themselves/), 'umoja');
    await user.click(screen.getByRole('button', { name: 'Save nomination settings' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH' && c.url === `/api/campaigns/${ID}`)?.body).toMatchObject({ nominate_eligibility: 'umoja' }));
    await user.click(screen.getByLabelText('Show results grouped by region'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PUT' && c.url === `/api/campaigns/${ID}/results-view`)?.body).toEqual({ group_by_region: true }));
  });

  it('an older campaign without positions still shows the plain candidates list', async () => {
    table[`GET /api/campaigns/${ID}`] = { ...adminCampaign(), positions: undefined, candidates: [{ id: 'c1', name: 'Ann', bio: null, photo_url: null }, { id: 'c2', name: 'Ben', bio: null, photo_url: null }] };
    adminPage();
    expect(await screen.findByRole('tab', { name: /^Candidates/ })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull();
    expect(screen.getByText('Ann')).toBeTruthy();
  });
});

// ---- accessibility (axe) ----------------------------------------------------------------------------------------------------------

describe('the new screens have no axe violations (WCAG 2.1 A and AA, plus best practice)', () => {
  it('the voter\'s campaign page with a done block, and a position ballot with region groups, an abstain line and a confirmation dialog', async () => {
    session(STAFF);
    table[`GET /api/vote/${TOKEN}`] = campaignInfo([true, false, false]);
    table[`GET /api/vote/${TOKEN}/positions/p2`] = { ...ballot([cand('ab', 'Abstain (none of the above)', null, null, { isAbstain: true }), cand('w', 'Wendy', 'r1', 'Erongo', { withdrawn: true })]), position: { id: 'p2', title: 'Finance Officer', description: 'Keeps the books' } };
    const { container } = app(`/v/${TOKEN}`);
    const user = userEvent.setup();
    await screen.findByRole('list', { name: 'Positions' });
    expect(await audit(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: /Finance Officer/ }));
    await user.click((await screen.findAllByRole('button', { name: /^Alice/ }))[0]);
    expect(await audit(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: /^Review vote for/ }));
    await screen.findByRole('dialog');
    expect(await audit(container)).toEqual([]);
  });

  it('the nomination page, as a new candidate and with a rejected profile', async () => {
    session(STAFF);
    table[`GET /api/nominate/${NTOKEN}`] = nominateInfo();
    const { container } = app(`/n/${NTOKEN}`);
    await screen.findByRole('heading', { name: 'Stand for Press Secretary' });
    expect(await audit(container)).toEqual([]);
    cleanup();
    table[`GET /api/nominate/${NTOKEN}`] = nominateInfo({ profile: { id: 'k1', name: 'Sam', bio: null, regionId: 'r1', status: 'rejected', reviewReason: 'Please fix the bio.', photoUrl: null } });
    const again = app(`/n/${NTOKEN}`);
    await screen.findByText('Not approved');
    expect(await audit(again.container)).toEqual([]);
  });

  it('the admin\'s position blocks with a position open for review, the add dialog, and the settings tab', async () => {
    table[`GET /api/campaigns/${ID}`] = adminCampaign();
    table[`GET /api/campaigns/${ID}/positions/p1/nominations`] = { nominations };
    const { container } = adminPage();
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: 'Manage candidates' }))[0]);
    await screen.findByText(/applied by Bob B/);
    expect(await audit(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: '+ Add a position' }));
    await screen.findByRole('dialog');
    expect(await audit(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await screen.findByLabelText('Show results grouped by region');
    expect(await audit(container)).toEqual([]);
  });

  it('per-position results, grouped by region', async () => {
    const { container } = render(<PositionResults r={{
      turnout: { votes: 6, eligible: 20 }, group_by_region: true,
      positions: [{ id: 'p1', title: 'Press Secretary', turnout: { votes: 6 }, tie: null, winners: [{ id: 'a', name: 'Alice', votes: 4 }], candidates: [{ id: 'a', name: 'Alice', votes: 4, region: 'Khomas' }, { id: 'b', name: 'Bob', votes: 2, region: 'Erongo' }] }],
    }} />);
    expect(await audit(container)).toEqual([]);
  });
});


// ---- the admin positions screen (docs/ballot-screen-redesign.md, "Admin — campaign positions screen") --------------------------------------------------
describe('the admin positions screen', () => {
  it('a row has one "Manage candidates" button and a "⋯" menu (role=menu) that opens with Edit, Move up / down and a red Remove; Escape closes it and returns focus', async () => {
    table[`GET /api/campaigns/${ID}`] = adminCampaign({ positions: [adminPos(0, 'Press Secretary'), adminPos(1, 'Finance Officer'), adminPos(2, 'Treasurer')] });
    const user = userEvent.setup();
    adminPage();
    await screen.findByRole('list', { name: 'Positions' });
    const more = screen.getByRole('button', { name: 'More actions for Finance Officer' });
    expect(more.getAttribute('aria-haspopup')).toBe('menu'); expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('menu')).toBeNull();
    await user.click(more);
    const menu = screen.getByRole('menu');
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(within(menu).getAllByRole('menuitem').map((x) => x.textContent)).toEqual(['Edit position', 'Move up', 'Move down', 'Remove position…']);   // a middle row: both moves
    expect(within(menu).getByRole('menuitem', { name: 'Remove position…' }).className).toContain('is-danger');
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Edit position' }));   // focus moves into the menu
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Move up' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(more);
    // the first row has no Move up, the last no Move down
    await user.click(screen.getByRole('button', { name: 'More actions for Press Secretary' }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((x) => x.textContent)).toEqual(['Edit position', 'Move down', 'Remove position…']);
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'More actions for Treasurer' }));
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem').map((x) => x.textContent)).toEqual(['Edit position', 'Move up', 'Remove position…']);
    // clicking elsewhere closes it too
    await user.click(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('"Remove position…" asks first and removes nothing until it is confirmed; Cancel keeps the position', async () => {
    table[`GET /api/campaigns/${ID}`] = adminCampaign();
    const user = userEvent.setup();
    adminPage();
    await user.click(await screen.findByRole('button', { name: 'More actions for Finance Officer' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove position…' }));
    const dlg = await screen.findByRole('dialog', { name: 'Remove Finance Officer?' });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('the open position expands under its own row: the button reads "Close ˄" with aria-expanded, the row gets the grey header and never the voter\'s navy selected border', async () => {
    table[`GET /api/campaigns/${ID}`] = adminCampaign();
    table[`GET /api/campaigns/${ID}/positions/p1/nominations`] = { nominations };
    const user = userEvent.setup();
    adminPage();
    const press = (await screen.findByRole('article', { name: 'Press Secretary' }));
    const btn = within(press).getByRole('button', { name: /Manage candidates/ });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(press.querySelector('.prow-body')).toBeNull();
    await user.click(btn);
    const close = within(press).getByRole('button', { name: 'Close' });
    expect(close.textContent).toBe('Close ˄');
    expect(close.getAttribute('aria-expanded')).toBe('true');
    expect(close.getAttribute('aria-controls')).toBe(press.querySelector('.prow-body')?.id);
    expect(press.classList.contains('is-open')).toBe(true);
    expect(press.classList.contains('position-selected')).toBe(false);                                  // not the candidate "selected" look
    const body = press.querySelector('.prow-body') as HTMLElement;                                      // inside the SAME article, under its row
    expect(press.contains(body)).toBe(true);
    expect(within(body).getByLabelText('Share this nomination link')).toBeTruthy();
    expect(await within(body).findByText('Alice')).toBeTruthy();                                        // the candidates
    // the other row is untouched
    expect(within(screen.getByRole('article', { name: 'Finance Officer' })).queryByRole('button', { name: 'Close' })).toBeNull();
    await user.click(close);
    expect(press.querySelector('.prow-body')).toBeNull();
    expect(within(press).getByRole('button', { name: 'Manage candidates' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('an open position with no nominations shows the empty state with the minimum and an "+ Add candidate" button', async () => {
    table[`GET /api/campaigns/${ID}`] = adminCampaign();
    table[`GET /api/campaigns/${ID}/positions/p2/nominations`] = { nominations: [] };
    const user = userEvent.setup();
    adminPage();
    await user.click((await screen.findAllByRole('button', { name: 'Manage candidates' }))[1]);
    expect(await screen.findByText('No nominations yet')).toBeTruthy();
    expect(screen.getByText('Share the link above, or add a candidate yourself. You need at least 2 approved to start the vote.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '+ Add candidate' }));
    expect(await screen.findByRole('form', { name: 'Add a candidate for Finance Officer' })).toBeTruthy();
  });

  it('the Actions panel: every position is a line (green tick / red cross); "Start voting" waits for all of them; "Delete draft…" is a small red text button with a confirm dialog', async () => {
    table[`GET /api/campaigns/${ID}`] = adminCampaign();
    const user = userEvent.setup();
    adminPage();
    const panel = await screen.findByRole('complementary');
    const lines = within(panel).getAllByRole('listitem');
    expect(lines.map((l) => l.className)).toEqual(['is-ok', 'is-bad']);
    expect(within(panel).getByRole('link', { name: 'Edit campaign' })).toBeTruthy();
    const del = within(panel).getByRole('button', { name: 'Delete draft…' });
    expect(del.className).toBe('delete-draft');                                                           // not a bordered "Edit campaign"-weight button
    await user.click(del);
    const dlg = await screen.findByRole('dialog', { name: 'Delete this draft?' });
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await user.click(within(dlg).getByRole('button', { name: 'Cancel' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('once every position is ready the checklist is all green and Start voting opens', async () => {
    table[`GET /api/campaigns/${ID}`] = adminCampaign({ positions: [adminPos(0, 'Press Secretary'), adminPos(1, 'Finance Officer', { counts: { approved: 3, submitted: 0, rejected: 0, withdrawn: 0, invited: 0 }, seats: 2, max_candidates: 4 })] });
    adminPage();
    const panel = await screen.findByRole('complementary');
    expect(within(panel).getAllByRole('listitem').map((l) => l.className)).toEqual(['is-ok', 'is-ok']);
    expect((within(panel).getByRole('button', { name: 'Start voting' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('3 of 2 approved · max 4 · 2 winners')).toBeTruthy();
    expect((screen.getByRole('article', { name: 'Finance Officer' }).querySelector('.prow-bar span') as HTMLElement).style.width).toBe('100%');   // capped at 100%
  });

  it('Add / Edit position: "Number of winners", "Minimum candidates to start" (default 2) and "Maximum candidates", a live summary line, and the eligibility text', async () => {
    table[`GET /api/campaigns/${ID}`] = adminCampaign();
    const user = userEvent.setup();
    adminPage();
    await user.click(await screen.findByRole('button', { name: '+ Add a position' }));
    const dlg = await screen.findByRole('dialog');
    expect((within(dlg).getByLabelText(/^Minimum candidates to start/) as HTMLInputElement).value).toBe('2');
    expect(within(dlg).queryByLabelText(/^Seats/)).toBeNull(); expect(within(dlg).queryByLabelText(/^Fewest candidates/)).toBeNull(); expect(within(dlg).queryByLabelText(/^Most candidates/)).toBeNull();
    expect(within(dlg).getByRole('status').textContent).toBe('1 winner, 2 or more candidates, voters pick 1.');
    await user.type(within(dlg).getByLabelText(/^Title/), 'Additional Members');
    await user.type(within(dlg).getByLabelText(/^Who can stand/), 'Must be from the HR Department');
    const winners = within(dlg).getByLabelText(/^Number of winners/);
    await user.clear(winners); await user.type(winners, '2');
    const min = within(dlg).getByLabelText(/^Minimum candidates to start/);
    await user.clear(min); await user.type(min, '3');
    await user.type(within(dlg).getByLabelText(/^Maximum candidates/), '13');
    expect(within(dlg).getByRole('status').textContent).toBe('2 winners, 3–13 candidates, voters pick 2.');
    await user.click(within(dlg).getByRole('button', { name: 'Add position' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST' && c.url === `/api/campaigns/${ID}/positions`)?.body).toEqual({
      title: 'Additional Members', description: null, rule_text: 'Must be from the HR Department', seats: 2, min_candidates: 3, max_candidates: 13 }));
  });

  it('the tabs say "Positions (n)" and the active tab is navy with a thicker underline', async () => {
    table[`GET /api/campaigns/${ID}`] = adminCampaign();
    adminPage();
    expect(await screen.findByRole('tab', { name: /^Positions\s*\(?2\)?$/ })).toBeTruthy();
  });
});

describe('the admin positions screen has no axe violations', () => {
  it('collapsed, with a menu open, expanded (with candidates), the empty state, and the dialogs', async () => {
    table[`GET /api/campaigns/${ID}`] = adminCampaign();
    table[`GET /api/campaigns/${ID}/positions/p1/nominations`] = { nominations };
    table[`GET /api/campaigns/${ID}/positions/p2/nominations`] = { nominations: [] };
    const user = userEvent.setup();
    const { container } = adminPage();
    await screen.findByRole('list', { name: 'Positions' });
    expect(await audit(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'More actions for Press Secretary' }));
    expect(await audit(container)).toEqual([]);
    await user.keyboard('{Escape}');
    await user.click(screen.getAllByRole('button', { name: 'Manage candidates' })[0]);
    await screen.findByText('Alice');
    expect(await audit(container)).toEqual([]);
    await user.click(screen.getAllByRole('button', { name: 'Manage candidates' })[0]);
    await screen.findByText('No nominations yet');
    expect(await audit(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'More actions for Finance Officer' }));
    await user.click(screen.getByRole('menuitem', { name: 'Remove position…' }));
    await screen.findByRole('dialog');
    expect(await audit(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Delete draft…' }));
    await screen.findByRole('dialog', { name: 'Delete this draft?' });
    expect(await audit(container)).toEqual([]);
  });
});
