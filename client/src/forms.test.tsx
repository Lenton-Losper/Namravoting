// Client tests for the two form bugs fixed together with "Allow edits after start":
//  1. a dialog's inputs lost focus after every typed character (the Dialog re-focused itself on every render);
//  2. the "who can vote" choice was not saved with a new campaign, and the edit screen's choice was lost when leaving with "Done".
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Dialog } from './ui';
import { CampaignPage } from './pages/admin/CampaignPage';
import { EditCampaign } from './pages/admin/EditCampaign';
import { NewCampaign } from './pages/admin/NewCampaign';
import { resetCsrf } from './api';

const ID = '50a77f0b-87bd-4f3f-b4fb-6833a94a1086';
const detail = (over: Record<string, unknown> = {}) => ({
  id: ID, title: 'Quarterly vote', description: null, status: 'open', opens_at: null, closes_at: null, eligibility: 'all', results_published: false,
  share_token: 'x'.repeat(32), share_url: 'http://localhost/v/' + 'x'.repeat(32), turnout: 2, eligible_emails: [], umoja_active_count: 0, allow_edits_after_start: false,
  candidates: [{ id: 'c1', name: 'Ann', bio: null, photo_url: null }, { id: 'c2', name: 'Ben', bio: null, photo_url: null }], edited_after_start: [], ...over,
});

type Call = { method: string; url: string; body: unknown };
let calls: Call[] = [];
let routes: Record<string, unknown> = {};
beforeEach(() => {
  calls = []; routes = {}; resetCsrf();
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    let body: unknown = init?.body;
    if (typeof body === 'string') body = JSON.parse(body);
    calls.push({ method, url, body });
    const hit = routes[`${method} ${url}`];
    const payload = url === '/api/csrf' ? { token: 't' } : hit ?? {};
    return new Response(JSON.stringify(payload), { status: method === 'POST' && url === '/api/campaigns' ? 201 : 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Dialog focus', () => {
  it('keeps focus in an input while typing, even though the parent passes a new onCancel on every render', async () => {
    function Harness() {
      const [text, setText] = useState('');
      const [open, setOpen] = useState(true);
      return open ? (
        <Dialog title="Reset votes?" confirmLabel="Reset" onConfirm={() => undefined} onCancel={() => setOpen(false)}>
          <label>Reason<input value={text} onChange={(e) => setText(e.target.value)} /></label>
        </Dialog>
      ) : <p>closed</p>;
    }
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByLabelText('Reason') as HTMLInputElement;
    await user.click(input);
    await user.keyboard('hello world');
    expect(input.value).toBe('hello world');
    expect(document.activeElement).toBe(input);
  });

  it('still closes on Escape with the latest handler, and hands focus back to what opened it', async () => {
    const onCancel = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>open it</button>
          {open && <Dialog title="T" confirmLabel="Ok" onConfirm={() => undefined} onCancel={() => { onCancel(); setOpen(false); }}><p>body</p></Dialog>}
        </>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByText('open it');
    await user.click(opener);
    expect(screen.getByRole('dialog')).toBeTruthy();
    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('the real "Reset votes" dialog', () => {
  it('lets you type the title and the reason without losing focus after each character', async () => {
    routes[`GET /api/campaigns/${ID}`] = detail();
    routes[`GET /api/campaigns/${ID}/results`] = { status: 'open', results_published: false, candidates: null, turnout: { votes: 2, eligible: null }, notices: [] };
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={[`/admin/c/${ID}`]}><Routes><Route path="/admin/c/:id" element={<CampaignPage />} /></Routes></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: 'Reset votes' }));
    const title = await screen.findByRole('textbox', { name: /Type the campaign title/ }) as HTMLInputElement;
    await user.click(title);
    await user.keyboard('Quarterly vote');
    expect(title.value).toBe('Quarterly vote');
    expect(document.activeElement).toBe(title);
    const reason = screen.getByRole('textbox', { name: /Reason/ }) as HTMLTextAreaElement;
    await user.click(reason);
    await user.keyboard('Wrong list was used');
    expect(reason.value).toBe('Wrong list was used');
    expect(document.activeElement).toBe(reason);
    // title + reason typed: the dialog's confirm button is now enabled
    expect((within(screen.getByRole('dialog')).getByRole('button', { name: 'Reset votes' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('the close dialog (reason for an early close) keeps focus too', async () => {
    routes[`GET /api/campaigns/${ID}`] = detail({ closes_at: new Date(Date.now() + 3600_000).toISOString() });
    routes[`GET /api/campaigns/${ID}/results`] = { status: 'open', results_published: false, candidates: null, turnout: { votes: 2, eligible: null }, notices: [] };
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={[`/admin/c/${ID}`]}><Routes><Route path="/admin/c/:id" element={<CampaignPage />} /></Routes></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: 'Close voting' }));
    const reason = await screen.findByRole('textbox', { name: /Reason for closing early/ }) as HTMLTextAreaElement;
    await user.click(reason);
    await user.keyboard('Everyone has voted');
    expect(reason.value).toBe('Everyone has voted');
    expect(document.activeElement).toBe(reason);
  });
});

describe('who can vote is saved', () => {
  it('creating a campaign sends the chosen mode ("All staff") and the "Allow edits" setting, which is off by default', async () => {
    routes['POST /api/campaigns'] = { id: ID };
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/admin/new']}><Routes><Route path="/admin/new" element={<NewCampaign />} /><Route path="/admin/c/:id/edit" element={<p>edit page</p>} /></Routes></MemoryRouter>);
    expect((screen.getByLabelText(/Allow edits after start/) as HTMLInputElement).checked).toBe(false);
    await user.type(screen.getByLabelText(/^Title/), 'All staff vote');
    await user.click(screen.getByLabelText(/All signed-in NamRA staff/));
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    await screen.findByText('edit page');
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/campaigns')!;
    expect(post.body).toMatchObject({ title: 'All staff vote', eligibility: 'all', allow_edits_after_start: false });
  });

  it('creating a campaign with the checkbox ticked and an email list sends both', async () => {
    routes['POST /api/campaigns'] = { id: ID };
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={['/admin/new']}><Routes><Route path="/admin/new" element={<NewCampaign />} /><Route path="/admin/c/:id/edit" element={<p>edit page</p>} /></Routes></MemoryRouter>);
    await user.type(screen.getByLabelText(/^Title/), 'List vote');
    await user.click(screen.getByLabelText(/Only these email addresses/));
    await user.type(screen.getByLabelText(/^Email addresses/), 'a@namra.org.na, B@namra.org.na');
    await user.click(screen.getByLabelText(/Allow edits after start/));
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    await screen.findByText('edit page');
    const post = calls.find((c) => c.method === 'POST' && c.url === '/api/campaigns')!;
    expect(post.body).toMatchObject({ eligibility: 'list', emails: ['a@namra.org.na', 'b@namra.org.na'], allow_edits_after_start: true });
  });

  it('on the edit screen, picking "All staff" is saved immediately (no separate button to forget)', async () => {
    routes[`GET /api/campaigns/${ID}`] = detail({ status: 'draft', eligibility: 'umoja', turnout: 0 });
    routes[`PUT /api/campaigns/${ID}/eligible`] = { mode: 'all', count: 0 };
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={[`/admin/c/${ID}/edit`]}><Routes><Route path="/admin/c/:id/edit" element={<EditCampaign />} /></Routes></MemoryRouter>);
    await user.click(await screen.findByLabelText(/All signed-in NamRA staff/));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT' && c.url === `/api/campaigns/${ID}/eligible`)).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ mode: 'all' });
  });

  it('an unsaved email list holds "Done" back, so the choice cannot be lost by leaving the page', async () => {
    routes[`GET /api/campaigns/${ID}`] = detail({ status: 'draft', eligibility: 'umoja', turnout: 0 });
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={[`/admin/c/${ID}/edit`]}><Routes><Route path="/admin/c/:id/edit" element={<EditCampaign />} /></Routes></MemoryRouter>);
    await user.click(await screen.findByLabelText(/Only these email addresses/));
    await user.type(screen.getByLabelText(/^Email addresses/), 'a@namra.org.na');
    expect((screen.getByRole('button', { name: 'Done' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Not saved yet.')).toBeTruthy();
  });
});

describe('editing after start', () => {
  const live = () => detail({ status: 'open', allow_edits_after_start: true, eligibility: 'umoja', turnout: 0 });

  it('an open campaign with "Allow edits" opens the edit screen: opening time locked, eligibility read-only, candidates editable before any vote', async () => {
    routes[`GET /api/campaigns/${ID}`] = live();
    render(<MemoryRouter initialEntries={[`/admin/c/${ID}/edit`]}><Routes><Route path="/admin/c/:id/edit" element={<EditCampaign />} /></Routes></MemoryRouter>);
    expect((await screen.findAllByText(/Edited after start/)).length).toBeGreaterThan(0);
    expect((screen.getByLabelText(/^Opens at/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByLabelText(/Allow edits after start/)).toBeNull();
    expect(screen.queryByLabelText(/Umoja members only/)).toBeNull();           // eligibility is not editable any more
    expect(screen.getByRole('button', { name: /Add candidate/ })).toBeTruthy();
  });

  it('after the first vote the candidates are locked on the edit screen', async () => {
    routes[`GET /api/campaigns/${ID}`] = detail({ status: 'open', allow_edits_after_start: true, eligibility: 'umoja', turnout: 1 });
    render(<MemoryRouter initialEntries={[`/admin/c/${ID}/edit`]}><Routes><Route path="/admin/c/:id/edit" element={<EditCampaign />} /></Routes></MemoryRouter>);
    expect(await screen.findByText(/the first vote has been cast/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add candidate/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Remove Ann/ })).toBeNull();
  });

  it('an open campaign WITHOUT the setting is sent back to the campaign page', async () => {
    routes[`GET /api/campaigns/${ID}`] = detail({ status: 'open', allow_edits_after_start: false });
    render(<MemoryRouter initialEntries={[`/admin/c/${ID}/edit`]}><Routes><Route path="/admin/c/:id/edit" element={<EditCampaign />} /><Route path="/admin/c/:id" element={<p>campaign page</p>} /></Routes></MemoryRouter>);
    expect(await screen.findByText('campaign page')).toBeTruthy();
  });

  it('saving details on a live campaign sends only title, description and closing time', async () => {
    routes[`GET /api/campaigns/${ID}`] = live();
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={[`/admin/c/${ID}/edit`]}><Routes><Route path="/admin/c/:id/edit" element={<EditCampaign />} /></Routes></MemoryRouter>);
    const title = await screen.findByLabelText(/^Title/);
    await user.clear(title);
    await user.type(title, 'Renamed vote');
    await user.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    const body = calls.find((c) => c.method === 'PATCH')!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['closes_at', 'description', 'title']);
    expect(body.title).toBe('Renamed vote');
  });

  it('the campaign page lists "Edited after start" with the time', async () => {
    routes[`GET /api/campaigns/${ID}`] = detail({ status: 'open', allow_edits_after_start: true, turnout: 0, edited_after_start: [{ kind: 'edited_after_start', at: '2026-11-12T10:00:00.000Z', by: 'Admin', reason: '', changes: [{ what: 'title', from: 'Old', to: 'New' }, { what: 'candidate_added', name: 'Cy' }] }] });
    routes[`GET /api/campaigns/${ID}/results`] = { status: 'open', results_published: false, candidates: null, turnout: { votes: 0, eligible: null }, notices: [] };
    render(<MemoryRouter initialEntries={[`/admin/c/${ID}`]}><Routes><Route path="/admin/c/:id" element={<CampaignPage />} /></Routes></MemoryRouter>);
    expect((await screen.findAllByText(/Edited after start/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/title changed from “Old” to “New”/)).toBeTruthy();
    expect(screen.getByText(/candidate added: Cy/)).toBeTruthy();
    expect(screen.getByText(/12 Nov/)).toBeTruthy();
  });
});
