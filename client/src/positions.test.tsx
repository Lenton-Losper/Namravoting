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
const block = (i: number, title: string, voted: boolean, candidateCount = 3) => ({ id: PID[i], title, description: null, seats: 1, voted, candidateCount });
const campaignInfo = (voted: boolean[]) => ({
  title: 'Umoja Committee 2026', description: 'Elect your committee', opensAt: null, closesAt: '2030-01-01T10:00:00Z', resultsPublished: false, voterState: voted.every(Boolean) ? 'already_voted' : 'can_vote',
  notices: [], candidates: [], regions: REGIONS, progress: { voted: voted.filter(Boolean).length, total: voted.length },
  positions: [block(0, 'Press Secretary', voted[0]), block(1, 'Finance Officer', voted[1], 2), block(2, 'Treasurer', voted[2], 2)],
});
const cand = (id: string, name: string, regionId: string | null, region: string | null, extra: Record<string, unknown> = {}) => ({ id, name, bio: `${name} bio`, photoUrl: null, isAbstain: false, withdrawn: false, positionId: PID[0], regionId, region, ...extra });
const ballot = (extra: Record<string, unknown>[] = []) => ({
  position: { id: PID[0], title: 'Press Secretary', description: null }, campaign: { title: 'Umoja Committee 2026', closesAt: null }, voterState: 'can_vote', regions: REGIONS, progress: { voted: 0, total: 3 },
  candidates: [cand('c1', 'Alice', 'r2', 'Khomas'), cand('c2', 'Bob', 'r1', 'Erongo'), cand('c3', 'Chipo', 'r3', 'Zambezi'), cand('c4', 'Dan', 'r2', 'Khomas'), ...extra],
});
const names = () => screen.getAllByRole('radio').map((r) => r.querySelector('strong')?.textContent);
const vote = (path = `/v/${TOKEN}`) => render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/v/:shareToken" element={<VotePage />} /></Routes></MemoryRouter>);

describe('the voter\'s campaign page', () => {
  it('shows a block per position and the progress, greys out a done block with a "Voted" tick, and never opens it again', async () => {
    table[`GET /api/vote/${TOKEN}`] = campaignInfo([true, false, false]);
    const user = userEvent.setup();
    vote();
    expect(await screen.findByRole('heading', { name: 'Umoja Committee 2026' })).toBeTruthy();
    expect(screen.getByText(/1 of 3/).parentElement?.textContent).toBe('1 of 3 positions voted');
    const grid = screen.getByRole('list', { name: 'Positions' });
    const blocks = within(grid).getAllByRole('button');
    expect(blocks.map((b) => b.getAttribute('aria-label'))).toEqual(['Press Secretary: voted', 'Finance Officer: 2 candidates, not voted yet', 'Treasurer: 2 candidates, not voted yet']);
    expect((blocks[0] as HTMLButtonElement).disabled).toBe(true);
    expect(blocks[0].textContent).toContain('Voted');
    expect(blocks[0].className).toContain('position-voted');
    expect((blocks[1] as HTMLButtonElement).disabled).toBe(false);
    await user.click(blocks[0]);                                                                       // a greyed-out block does nothing
    expect(calls.some((c) => c.url.includes('/positions/'))).toBe(false);
  });

  it('opens a position, filters by region, groups candidates by region and votes with one choice and a confirmation', async () => {
    table[`GET /api/vote/${TOKEN}`] = campaignInfo([false, false, false]);
    table[`GET /api/vote/${TOKEN}/positions/p1`] = ballot([cand('ab', 'Abstain (none of the above)', null, null, { isAbstain: true })]);
    const user = userEvent.setup();
    vote();
    await user.click(await screen.findByRole('button', { name: /Press Secretary/ }));
    const select = await screen.findByLabelText('Region');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['All regions', 'Erongo', 'Khomas', 'Zambezi']);

    // grouped by region in the campaign's region order, with the abstain line last and outside any region
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent).filter((t) => /\(\d+\)/.test(t ?? ''));
    expect(headings).toEqual(['Erongo (1)', 'Khomas (2)', 'Zambezi (1)']);
    expect(names()).toEqual(['Bob', 'Alice', 'Dan', 'Chipo', 'Abstain (none of the above)']);
    expect(screen.getByText('4 candidates')).toBeTruthy();

    // filter: only Khomas candidates (and the abstain line, which belongs to no region)
    await user.selectOptions(select, 'r2');
    expect(names()).toEqual(['Alice', 'Dan', 'Abstain (none of the above)']);
    expect(screen.getByText('Showing 2 of 4 candidates')).toBeTruthy();

    // a choice hidden by the filter is dropped, so nobody confirms a candidate they cannot see
    await user.click(screen.getAllByRole('radio')[0]);
    expect(screen.getAllByRole('radio')[0].getAttribute('aria-checked')).toBe('true');
    await user.selectOptions(select, 'r3');
    expect(screen.getAllByRole('radio').every((r) => r.getAttribute('aria-checked') === 'false')).toBe(true);
    expect((screen.getByRole('button', { name: 'Cast vote' }) as HTMLButtonElement).disabled).toBe(true);

    await user.selectOptions(select, '');
    await user.click(screen.getByRole('radio', { name: /Chipo/ }));
    await user.click(screen.getByRole('button', { name: 'Cast vote' }));
    expect(await screen.findByRole('heading', { name: 'Vote for Chipo as Press Secretary?' })).toBeTruthy();
    table[`GET /api/vote/${TOKEN}`] = campaignInfo([true, false, false]);
    await user.click(screen.getByRole('button', { name: 'Confirm vote' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toMatchObject({ url: `/api/vote/${TOKEN}/positions/p1`, body: { candidateId: 'c3' } }));
    // back on the campaign page, the block is now done and the progress moved on
    expect(await screen.findByText(/Your vote for Press Secretary was recorded/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Press Secretary: voted' })).toBeTruthy();
    expect(screen.getByText(/1 of 3/)).toBeTruthy();
  });

  it('a region with no candidates says so, and "All regions" brings everyone back', async () => {
    table[`GET /api/vote/${TOKEN}`] = campaignInfo([false, false, false]);
    table[`GET /api/vote/${TOKEN}/positions/p1`] = { ...ballot(), candidates: [cand('c1', 'Alice', 'r2', 'Khomas'), cand('c2', 'Bob', 'r1', 'Erongo')] };
    const user = userEvent.setup();
    vote();
    await user.click(await screen.findByRole('button', { name: /Press Secretary/ }));
    await user.selectOptions(await screen.findByLabelText('Region'), 'r3');
    expect(screen.getByText(/No candidates in this region/)).toBeTruthy();
    await user.selectOptions(screen.getByLabelText('Region'), '');
    expect(screen.getAllByRole('radio')).toHaveLength(2);
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

  it('when every position is voted the page says so; results show per position once published', async () => {
    table[`GET /api/vote/${TOKEN}`] = { ...campaignInfo([true, true, true]), resultsPublished: true, voterState: 'closed' };
    table[`GET /api/vote/${TOKEN}/results`] = {
      title: 'T', turnout: { votes: 5, eligible: 10 }, group_by_region: false, notices: [], publication: null, quorum: null, candidates: [],
      positions: [{ id: 'p1', title: 'Press Secretary', turnout: { votes: 5 }, tie: null, winners: [{ id: 'c1', name: 'Alice', votes: 3 }], candidates: [{ id: 'c1', name: 'Alice', votes: 3, region: 'Khomas' }, { id: 'c2', name: 'Bob', votes: 2, region: 'Erongo' }] }],
    };
    vote();
    expect(await screen.findByRole('region', { name: 'Press Secretary' })).toBeTruthy();
    expect(screen.getByText(/Winner:/).parentElement?.textContent).toContain('Alice');
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
    const name = screen.getByLabelText(/Display name/) as HTMLInputElement;
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
    expect(screen.queryByLabelText(/Display name/)).toBeNull();
    cleanup();
    table[`GET /api/nominate/${NTOKEN}`] = nominateInfo({ canEdit: false, state: 'ended' });
    nominate();
    expect(await screen.findByRole('heading', { name: 'Nominations are closed' })).toBeTruthy();
    expect(screen.getByText('Nominations closed when voting started.')).toBeTruthy();
    expect(screen.queryByLabelText(/Display name/)).toBeNull();
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
  it('shows a block per position with approved counts, review counts and the nomination status, and says what blocks the start', async () => {
    table[`GET /api/campaigns/${ID}`] = adminCampaign();
    adminPage();
    const grid = await screen.findByRole('list', { name: 'Positions' });
    const press = within(grid).getByRole('article', { name: 'Press Secretary' });
    expect(within(press).getByText('2 approved')).toBeTruthy();
    expect(within(press).getByText('1 to review')).toBeTruthy();
    expect(within(press).getByText('Nominations open')).toBeTruthy();
    const fin = within(grid).getByRole('article', { name: 'Finance Officer' });
    expect(within(fin).getByText('1 approved')).toBeTruthy();
    expect(within(fin).getByText('No nomination link yet')).toBeTruthy();
    expect(within(fin).getByText('Needs at least 2 approved')).toBeTruthy();
    expect(screen.getAllByText(/Still short: Finance Officer/).length).toBeGreaterThan(0);
    expect((screen.getByRole('button', { name: 'Start voting' }) as HTMLButtonElement).disabled).toBe(true);
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

    await user.click(screen.getByRole('button', { name: 'Move Press Secretary down' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/positions/reorder'))?.body).toEqual({ ids: [PID[1], PID[0]] }));
    expect((screen.getByRole('button', { name: 'Move Press Secretary up' }) as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Edit Finance Officer' }));
    const edit = await screen.findByRole('dialog');
    await user.clear(within(edit).getByLabelText(/^Title/)); await user.type(within(edit).getByLabelText(/^Title/), 'Finance Lead');
    await user.click(within(edit).getByRole('button', { name: 'Save position' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH' && c.url === `/api/campaigns/${ID}/positions/${PID[1]}`)?.body).toMatchObject({ title: 'Finance Lead' }));

    await user.click(screen.getByRole('button', { name: 'Remove Finance Officer' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove position' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === `/api/campaigns/${ID}/positions/${PID[1]}`)).toBe(true));
  });

  it('reviews nominations: approve, and reject with a reason (the button waits for one)', async () => {
    table[`GET /api/campaigns/${ID}`] = adminCampaign();
    table[`GET /api/campaigns/${ID}/positions/p1/nominations`] = { nominations };
    const user = userEvent.setup();
    adminPage();
    await user.click((await screen.findAllByRole('button', { name: 'Manage' }))[0]);
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
    const buttons = await screen.findAllByRole('button', { name: 'Manage' });
    await user.click(buttons[1]);
    await user.click(await screen.findByRole('button', { name: 'Invite candidates' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === `/api/campaigns/${ID}/positions/p2/invite`)).toBe(true));
    // the first position already has a link: its panel shows the link and the QR image
    cleanup();
    adminPage();
    await user.click((await screen.findAllByRole('button', { name: 'Manage' }))[0]);
    table[`GET /api/campaigns/${ID}/positions/p1/nominations`] = { nominations };
    const link = (await screen.findByLabelText(/Nomination link for Press Secretary/)) as HTMLInputElement;
    expect(link.value).toBe(`http://localhost/n/${NTOKEN}`);
    expect((screen.getByAltText('QR code for the Press Secretary nomination link') as HTMLImageElement).getAttribute('src')).toBe(`/api/campaigns/${ID}/positions/p1/invite.png`);
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
    await user.click((await screen.findAllByRole('radio'))[0]);
    expect(await audit(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Cast vote' }));
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
    await user.click((await screen.findAllByRole('button', { name: 'Manage' }))[0]);
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
