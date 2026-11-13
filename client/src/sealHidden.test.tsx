// The "Verify results integrity" panel is hidden for now (TODO(re-enable) in CampaignPage.tsx). Server-side sealing and the verify API are unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CampaignPage } from './pages/admin/CampaignPage';
import { resetCsrf } from './api';

const ID = '50a77f0b-87bd-4f3f-b4fb-6833a94a1086';
const calls: string[] = [];
beforeEach(() => {
  calls.length = 0; resetCsrf();
  const table: Record<string, unknown> = {
    [`GET /api/campaigns/${ID}`]: { id: ID, title: 'Quarterly vote', description: null, status: 'closed', opens_at: null, closes_at: null, eligibility: 'all', results_published: false, share_token: 'x'.repeat(32),
      share_url: 'http://localhost/v/x', turnout: 2, eligible_emails: [], umoja_active_count: 0, edited_after_start: [], my_role: 'owner', candidates: [{ id: 'c1', name: 'Ann', bio: null, photo_url: null }, { id: 'c2', name: 'Ben', bio: null, photo_url: null }] },
    [`GET /api/campaigns/${ID}/results`]: { status: 'closed', results_published: false, candidates: [{ id: 'c1', name: 'Ann', votes: 2 }, { id: 'c2', name: 'Ben', votes: 0 }], turnout: { votes: 2, eligible: null }, notices: [] },
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`; calls.push(key);
    return new Response(JSON.stringify(url === '/api/csrf' ? { token: 't' } : table[key] ?? {}), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('Verify results integrity (hidden)', () => {
  it('a closed campaign shows its results but no verify button or panel, and never calls the verify API on its own', async () => {
    const user = userEvent.setup();
    render(<MemoryRouter initialEntries={[`/admin/c/${ID}`]}><Routes><Route path="/admin/c/:id" element={<CampaignPage />} /></Routes></MemoryRouter>);
    await user.click(await screen.findByRole('tab', { name: /Results/ }));
    expect(await screen.findByText('Ann')).toBeTruthy();
    expect(screen.queryByText(/Verify results integrity/)).toBeNull();
    expect(calls.some((c) => c.endsWith('/verify'))).toBe(false);
    expect(screen.getByRole('button', { name: 'Publish results' })).toBeTruthy();   // publishing is unchanged (the server still blocks it on a mismatch)
  });
});
