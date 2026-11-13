// Automated WCAG 2.1 AA checks (axe-core) over the real pages, with the real header, navigation and dialogs. Colour contrast is checked
// separately from the stylesheet (contrast.test.ts), because jsdom cannot compute it. Keyboard and screen-reader behaviour that axe cannot see
// is covered by the targeted tests below. A person still has to review the result with a screen reader (docs/accessibility.md).
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { App } from './App';
import { AuthProvider } from './auth';
import { resetCsrf } from './api';

const ID = '50a77f0b-87bd-4f3f-b4fb-6833a94a1086';
const TOKEN = 'a'.repeat(32);
const ADMIN = { oid: 'o1', email: 'admin@x.test', displayName: 'Olivia Owner', roles: ['CampaignAdmin'] };
const STAFF = { oid: 's1', email: 'staff@x.test', displayName: 'Sam Staff', roles: [] };

let table: Record<string, unknown> = {};
beforeEach(() => {
  table = {}; resetCsrf(); sessionStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = url === '/api/csrf' ? { token: 't' } : table[`${method} ${url}`] ?? {};
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const session = (user: object | null, extra: Record<string, unknown> = {}) => { table['GET /api/session'] = { user, authMode: 'entra', observing: 0, notices: [], ...extra }; };

async function audit(container: HTMLElement) {
  const r = await axe.run(container, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }, rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.slice(0, 4).map((n) => n.target.join(' ')).join('\n    ')}`);
}
const page = (path: string) => render(<MemoryRouter initialEntries={[path]}><AuthProvider><App /></AuthProvider></MemoryRouter>);

const candidates = [{ id: 'c1', name: 'Ann', bio: 'Finance', photo_url: null }, { id: 'c2', name: 'Ben', bio: null, photo_url: null }];
const campaign = (over: Record<string, unknown> = {}) => ({
  id: ID, title: 'Quarterly vote', description: 'Choose one', status: 'open', opens_at: null, closes_at: '2030-01-01T10:00:00Z', eligibility: 'list', results_published: false, share_token: TOKEN,
  share_url: `http://localhost/v/${TOKEN}`, turnout: 2, eligible_emails: ['a@x.test'], umoja_active_count: 0, allow_edits_after_start: true, allow_abstain: true, edited_after_start: [], my_role: 'owner', require_approval: false,
  candidates, publish_at: null, ...over,
});

describe('pages have no axe violations (WCAG 2.1 A and AA, plus best practice)', () => {
  it('sign-in page', async () => {
    session(null);
    const { container } = page('/login?expired=1');
    await screen.findByRole('link', { name: 'Sign in with Microsoft' });
    expect(await audit(container)).toEqual([]);
  });

  it('My votes, with the Observing link', async () => {
    session(STAFF, { observing: 1 });
    table['GET /api/vote'] = { campaigns: [{ shareToken: TOKEN, title: 'Quarterly vote', description: null, opensAt: null, closesAt: '2030-01-01T10:00:00Z', resultsPublished: false, voterState: 'can_vote' }] };
    const { container } = page('/votes');
    await screen.findByText('Quarterly vote');
    expect(await audit(container)).toEqual([]);
  });

  it('the ballot, with an Abstain line and a withdrawn candidate, and its confirmation dialog', async () => {
    session(STAFF);
    table[`GET /api/vote/${TOKEN}`] = { title: 'Quarterly vote', description: 'Choose one', opensAt: null, closesAt: '2030-01-01T10:00:00Z', resultsPublished: false, voterState: 'can_vote',
      notices: [{ kind: 'candidate_withdrawn', at: '2026-01-01T10:00:00Z', by: 'Olivia', reason: 'Withdrew for personal reasons', candidate: 'Cy' }],
      candidates: [{ id: 'c1', name: 'Ann', bio: 'Finance', photoUrl: null }, { id: 'c3', name: 'Cy', bio: null, photoUrl: null, withdrawn: true }, { id: 'c9', name: 'Abstain (none of the above)', bio: null, photoUrl: null, isAbstain: true }] };
    const { container } = page(`/v/${TOKEN}`);
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('radio'))[0]);
    expect(await audit(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Cast vote' }));
    await screen.findByRole('dialog');
    expect(await audit(container)).toEqual([]);
  });

  it('the published results with a tie and a quorum warning', async () => {
    session(STAFF);
    table[`GET /api/vote/${TOKEN}`] = { title: 'T', description: null, opensAt: null, closesAt: null, resultsPublished: true, voterState: 'closed', notices: [], candidates: [] };
    table[`GET /api/vote/${TOKEN}/results`] = { title: 'T', candidates: [{ id: 'a', name: 'Ann', votes: 2 }, { id: 'b', name: 'Ben', votes: 2 }, { id: 'x', name: 'Abstain', votes: 1, is_abstain: true }], turnout: { votes: 5, eligible: 10 },
      tie: { names: ['Ann', 'Ben'], votes: 2 }, quorum: { percent: 75, eligible: 10, needed: 8, votes: 5, met: false }, publication: { by: 'Olivia', at: '2030-01-01T10:00:00Z', scheduled: false }, notices: [] };
    const { container } = page(`/v/${TOKEN}`);
    await screen.findByText(/Tie for first place/);
    expect(await audit(container)).toEqual([]);
  });

  it('the admin dashboard', async () => {
    session(ADMIN);
    table['GET /api/campaigns/mine'] = { campaigns: [{ ...campaign(), turnout: 2, eligible_count: 4, created_at: '2026-01-01T00:00:00Z' }, { ...campaign({ id: 'd2', title: 'A draft', status: 'draft' }), turnout: 0, eligible_count: null, created_at: '2026-01-02T00:00:00Z' }] };
    const { container } = page('/admin');
    await screen.findAllByText('Quarterly vote');
    expect(await audit(container)).toEqual([]);
  });

  it('create campaign', async () => {
    session(ADMIN);
    const { container } = page('/admin/new');
    await screen.findByRole('heading', { name: 'Create campaign' });
    expect(await audit(container)).toEqual([]);
  });

  it('the campaign page: every tab, and the dialogs', async () => {
    session(ADMIN);
    table[`GET /api/campaigns/${ID}`] = campaign({ require_approval: true });
    table[`GET /api/campaigns/${ID}/results`] = { status: 'open', results_published: false, candidates: null, turnout: { votes: 2, eligible: 4 }, notices: [] };
    table[`GET /api/campaigns/${ID}/notify`] = { configured: true, open: true, mailable: true, total: 4, reachable: 4, unreachable: 0, not_voted: 2, last_sent: { open: null, reminder: null, closing_soon: null }, min_interval_minutes: 60 };
    table[`GET /api/campaigns/${ID}/late-voters`] = { enabled: true, applicable: true, mode: 'list', entries: [{ at: '2026-01-02T08:00:00Z', by: 'Olivia', identifier: 'late@x.test', reason: 'Hired on Monday' }] };
    table[`GET /api/campaigns/${ID}/team`] = { owner: { name: 'Olivia Owner', email: 'o@x.test' }, require_approval: true, my_role: 'owner', approval_valid_hours: 24, members: [{ oid: 'm1', role: 'co_admin', name: 'Cara', email: 'c@x.test', added_at: '2026-01-01T00:00:00Z' }],
      approvals: [{ id: 'a1', kind: 'reset', status: 'pending', payload: { reason: 'Wrong list' }, requested_at: '2026-01-02T00:00:00Z', decided_at: null, decision_note: null, executed_at: null, requested_by: 'o', requested_by_name: 'Olivia', decided_by_name: null, executable: false }] };
    const { container } = page(`/admin/c/${ID}`);
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: 'Quarterly vote' });
    expect(await audit(container)).toEqual([]);                                         // Candidates tab (with withdraw buttons and notify panel)
    for (const tab of ['Eligibility', 'Results', 'Team']) {
      await user.click(screen.getByRole('tab', { name: new RegExp(tab) }));
      await waitFor(() => expect(screen.getByRole('tab', { name: new RegExp(tab) }).getAttribute('aria-selected')).toBe('true'));
      expect(await audit(container)).toEqual([]);
    }
    await user.click(screen.getByRole('button', { name: /Request reset/ }));
    await screen.findByRole('dialog');
    expect(await audit(container)).toEqual([]);
  });

  it('edit campaign', async () => {
    session(ADMIN);
    table[`GET /api/campaigns/${ID}`] = campaign({ status: 'draft' });
    const { container } = page(`/admin/c/${ID}/edit`);
    await screen.findByRole('button', { name: 'Save details' });
    expect(await audit(container)).toEqual([]);
  });

  it('the observer page', async () => {
    session(STAFF, { observing: 1 });
    table[`GET /api/observe/${ID}`] = { id: ID, title: 'Chair', description: null, status: 'closed', eligibility: 'all', owner: 'Olivia', opens_at: null, closes_at: null, results_published: false, archived: false, require_approval: false,
      turnout: { votes: 4, eligible: null }, result: { candidates: [{ id: 'a', name: 'Ann', votes: 3 }, { id: 'b', name: 'Ben', votes: 1 }], turnout: { votes: 4, eligible: null }, tie: null, quorum: null },
      seal: { chain_ok: true, chain_checked: 5, sealed: true, sealed_at: '2026-01-02T00:00:00Z', seal_hash: 'abc123', seal_seq: 4, tallies_match: true, receipts_match: true, sealed_tallies: [], sealed_turnout: 4 },
      notices: [], team: [{ name: 'Obi', role: 'observer' }], approvals: [], audit: [{ seq: 1, at: '2026-01-01T00:00:00Z', action: 'campaign.create', actor: 'Olivia', hash: 'h', details: { title: 'Chair' } }] };
    const { container } = page(`/observe/${ID}`);
    await screen.findByText(/Verified: the result is sealed/);
    expect(await audit(container)).toEqual([]);
  });
});

describe('keyboard and screen-reader basics', () => {
  it('there is a "skip to main content" link as the first focusable thing, and it targets the main landmark', async () => {
    session(STAFF);
    table['GET /api/vote'] = { campaigns: [] };
    page('/votes');
    const user = userEvent.setup();
    await screen.findByRole('main');
    await user.tab();
    const skip = document.activeElement as HTMLAnchorElement;
    expect(skip.textContent).toBe('Skip to main content');
    expect(skip.getAttribute('href')).toBe('#main');
    expect(document.getElementById('main')?.tagName).toBe('MAIN');
  });

  it('the page has one main landmark, a labelled navigation, and the top bar logo has alt text', async () => {
    session(ADMIN);
    table['GET /api/campaigns/mine'] = { campaigns: [] };
    page('/admin');
    await screen.findAllByRole('main');
    expect(screen.getAllByRole('main')).toHaveLength(1);
    expect(screen.getAllByRole('navigation').every((n) => n.getAttribute('aria-label'))).toBe(true);
    expect(screen.getAllByRole('img', { name: 'NamRA' }).length).toBeGreaterThan(0);
  });

  it('a dialog is announced as a modal dialog with a name, and Escape closes it', async () => {
    session(STAFF);
    table[`GET /api/vote/${TOKEN}`] = { title: 'T', description: null, opensAt: null, closesAt: null, resultsPublished: false, voterState: 'can_vote', notices: [], candidates: [{ id: 'c1', name: 'Ann', bio: null, photoUrl: null }, { id: 'c2', name: 'Ben', bio: null, photoUrl: null }] };
    page(`/v/${TOKEN}`);
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('radio'))[0]);
    await user.click(screen.getByRole('button', { name: 'Cast vote' }));
    const dlg = await screen.findByRole('dialog');
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(dlg.getAttribute('aria-labelledby') || dlg.getAttribute('aria-label')).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
