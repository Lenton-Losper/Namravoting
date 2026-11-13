// Poor signal: a lost response must never look like a failed vote that is safe to repeat, or like a recorded one.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { VotePage } from './pages/Vote';
import { resetCsrf } from './api';

const TOKEN = 'a'.repeat(32);
const info = (voterState = 'can_vote') => ({ title: 'T', description: null, opensAt: null, closesAt: null, resultsPublished: false, voterState, notices: [],
  candidates: [{ id: 'c1', name: 'Ann', bio: null, photoUrl: null }, { id: 'c2', name: 'Ben', bio: null, photoUrl: null }] });

/** What the network does for each kind of request, changeable during a test. */
let post: 'drop' | 'ok' = 'drop';
let get: () => Response = () => new Response(JSON.stringify(info()), { status: 200, headers: { 'content-type': 'application/json' } });
let posts = 0;
beforeEach(() => {
  post = 'drop'; posts = 0; resetCsrf(); sessionStorage.clear();
  get = () => new Response(JSON.stringify(info()), { status: 200, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/csrf') return new Response(JSON.stringify({ token: 't' }), { status: 200, headers: { 'content-type': 'application/json' } });
    if ((init?.method ?? 'GET') === 'POST') { posts++; if (post === 'drop') throw new TypeError('network down'); return new Response('{}', { status: 201, headers: { 'content-type': 'application/json' } }); }
    return get();
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const down = () => new Response(JSON.stringify({ error: 'down' }), { status: 500, headers: { 'content-type': 'application/json' } });
async function castVote() {
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={[`/v/${TOKEN}`]}><Routes><Route path="/v/:shareToken" element={<VotePage />} /></Routes></MemoryRouter>);
  await user.click((await screen.findAllByRole('radio'))[0]);
  await user.click(screen.getByRole('button', { name: 'Cast vote' }));
  await user.click(await screen.findByRole('button', { name: 'Confirm vote' }));
  return user;
}

describe('a vote whose answer was lost', () => {
  it('when the server cannot be reached to check, says the vote MAY have been recorded and does not offer to vote again', async () => {
    get = () => { return posts === 0 ? new Response(JSON.stringify(info()), { status: 200 }) : down(); };
    await castVote();
    expect(await screen.findByRole('heading', { name: 'Your vote may not have been recorded' })).toBeTruthy();
    expect(screen.queryAllByRole('radio')).toHaveLength(0);                              // no ballot to press again
    expect(screen.queryByRole('button', { name: 'Cast vote' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Go to My votes' }).getAttribute('href')).toBe('/votes');
    expect(posts).toBe(1);                                                               // nothing was sent twice
  });

  it('"Check again" finds that the vote WAS recorded', async () => {
    get = () => (posts === 0 ? new Response(JSON.stringify(info()), { status: 200 }) : down());
    const user = await castVote();
    await user.click(await screen.findByRole('button', { name: 'Check again' }));
    expect(screen.getByRole('heading', { name: 'Your vote may not have been recorded' })).toBeTruthy();   // still no signal: still uncertain
    get = () => new Response(JSON.stringify(info('already_voted')), { status: 200 });
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByRole('heading', { name: 'You have already voted' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Your vote may not have been recorded' })).toBeNull();
  });

  it('"Check again" finds that the vote was NOT recorded, and then voting again is allowed', async () => {
    get = () => (posts === 0 ? new Response(JSON.stringify(info()), { status: 200 }) : down());
    const user = await castVote();
    await user.click(await screen.findByRole('button', { name: 'Check again' }));
    get = () => new Response(JSON.stringify(info()), { status: 200 });
    post = 'ok';
    await user.click(screen.getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Your vote was not recorded. You can vote again.')).toBeTruthy();
    await user.click((await screen.findAllByRole('radio'))[1]);
    await user.click(screen.getByRole('button', { name: 'Cast vote' }));
    await user.click(await screen.findByRole('button', { name: 'Confirm vote' }));
    expect(await screen.findByRole('heading', { name: 'Your vote has been recorded' })).toBeTruthy();
    expect(posts).toBe(2);
  });

  it('when the server CAN be reached and has no receipt, it says plainly that the vote was not recorded', async () => {
    await castVote();                                                                    // the POST is dropped, the check works and says "can vote"
    expect(await screen.findByText('Your vote was not recorded. Please try again.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Your vote may not have been recorded' })).toBeNull();
  });

  it('when the check shows the vote did land, the person is told they have voted', async () => {
    get = () => (posts === 0 ? new Response(JSON.stringify(info()), { status: 200 }) : new Response(JSON.stringify(info('already_voted')), { status: 200 }));
    await castVote();
    expect(await screen.findByRole('heading', { name: 'You have already voted' })).toBeTruthy();
  });
});

describe('offline', () => {
  it('shows a plain notice while the browser is offline, and removes it when it is back', async () => {
    render(<MemoryRouter initialEntries={[`/v/${TOKEN}`]}><Routes><Route path="/v/:shareToken" element={<VotePage />} /></Routes></MemoryRouter>);
    await screen.findAllByRole('radio');
    expect(screen.queryByText(/You appear to be offline/)).toBeNull();
    act(() => { window.dispatchEvent(new Event('offline')); });
    expect(await screen.findByText(/You appear to be offline/)).toBeTruthy();
    act(() => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(screen.queryByText(/You appear to be offline/)).toBeNull());
  });
});
