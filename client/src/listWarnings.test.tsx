// Voter-list warnings: exactly which entries are invalid or not @namra.org.na, listed addresses nobody has signed in with, and the test-mode
// warning that shows while the typed-email demo sign-in is on.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { AuthProvider } from './auth';
import { checkEmails, EligibilityPicker, ListNotes, TEST_MODE_TEXT, TestModeWarning, type EligMode } from './eligibility';
import { resetCsrf } from './api';

function session(authMode: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/csrf' ? { token: 't' } : { user: { oid: 'o', email: 'a@namra.org.na', displayName: 'A', roles: ['CampaignAdmin'] }, authMode, observing: 0, notices: [] }),
    { status: 200, headers: { 'content-type': 'application/json' } })));
}
beforeEach(() => resetCsrf());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('checkEmails', () => {
  it('names the entries that are not email addresses and the ones outside @namra.org.na', () => {
    expect(checkEmails(['ok@namra.org.na', 'not-an-email', 'a@b', 'guest@gmail.com', 'x@sub.namra.org.na'])).toEqual({
      invalid: ['not-an-email', 'a@b'], notNamra: ['guest@gmail.com', 'x@sub.namra.org.na'],
    });
  });
});

describe('the test-mode warning', () => {
  const text = (m: EligMode) => <AuthProvider><TestModeWarning mode={m} /></AuthProvider>;

  it.each(['list', 'umoja'] as const)('shows in email-demo on a %s campaign, with the exact wording', async (mode) => {
    session('email-demo');
    render(text(mode));
    expect((await screen.findByRole('alert')).textContent).toBe("Test mode: sign-in doesn't verify identity. Don't use for a real vote.");
    expect(TEST_MODE_TEXT).toBe("Test mode: sign-in doesn't verify identity. Don't use for a real vote.");
  });

  it('is not shown for a vote open to all staff, nor with Microsoft sign-in', async () => {
    session('email-demo');
    const { unmount } = render(text('all'));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('alert')).toBeNull();
    unmount();
    session('entra');
    render(text('list'));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('appears inside the eligibility picker as soon as a list or Umoja is chosen', async () => {
    session('email-demo');
    function Host() { const [m, setM] = useState<EligMode>('all'); const [t, setT] = useState(''); return <AuthProvider><EligibilityPicker mode={m} onMode={setM} text={t} onText={setT} /></AuthProvider>; }
    render(<Host />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(TEST_MODE_TEXT)).toBeNull();
    await userEvent.setup().click(screen.getByLabelText('Umoja members only'));
    expect(await screen.findByText(TEST_MODE_TEXT)).toBeTruthy();
  });
});

describe('list notes', () => {
  it('while typing, the picker lists exactly which entries are invalid or not @namra.org.na', async () => {
    function Host() { const [t, setT] = useState(''); return <EligibilityPicker mode="list" onMode={() => undefined} text={t} onText={setT} />; }
    render(<Host />);
    await userEvent.setup().type(screen.getByLabelText(/^Email addresses/), 'a@namra.org.na, typo-here, guest@gmail.com');
    expect(screen.getByText(/1 entry is not an email address/).parentElement!.textContent).toContain('typo-here');
    expect(screen.getByText(/1 address is not @namra.org.na/).parentElement!.textContent).toContain('guest@gmail.com');
  });

  it('says how many listed addresses have never signed in, and names them; a leaver note keeps the count honest', async () => {
    session('entra');
    render(<AuthProvider><ListNotes neverSignedIn={['a@namra.org.na', 'b@namra.org.na']} left={2} /></AuthProvider>);
    const n = await screen.findByText(/2 listed addresses have never signed in with a Microsoft account/);
    expect(n.parentElement!.textContent).toContain('a@namra.org.na, b@namra.org.na');
    expect(screen.getByText(/2 listed people have left NamRA\. They stay on the list/)).toBeTruthy();
  });

  it('renders nothing when there is nothing to say', () => {
    const { container } = render(<ListNotes />);
    expect(container.textContent).toBe('');
  });
});
