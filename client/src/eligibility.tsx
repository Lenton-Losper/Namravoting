import { useId } from 'react';
import { useAuth } from './auth';

export type EligMode = 'umoja' | 'all' | 'list';

export const parseEmails = (raw: string) => [...new Set(raw.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];

const NAMRA_DOMAIN = 'namra.org.na';
const looksLikeEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
/** The same check the server makes when the list is saved (server/src/domain/eligibility.ts): which entries are not email addresses, which are not @namra.org.na. */
export function checkEmails(entries: string[]): { invalid: string[]; notNamra: string[] } {
  return { invalid: entries.filter((e) => !looksLikeEmail(e)), notNamra: entries.filter((e) => looksLikeEmail(e) && !e.endsWith('@' + NAMRA_DOMAIN)) };
}

/** What the server found when it saved a list (PUT /eligible, POST /campaigns): exact entries, nothing was rejected for them. */
export interface ListWarnings { invalid: string[]; not_namra: string[]; never_signed_in: string[] }
/** What an admin should know about a saved list (GET /campaigns/:id). */
export interface ListSummary { count: number; left: number; not_namra: string[]; never_signed_in: string[]; sha256: string }

export const TEST_MODE_TEXT = "Test mode: sign-in doesn't verify identity. Don't use for a real vote.";

/** While AUTH_MODE=email-demo anyone can sign in as any address, so a vote with a voter list (or Umoja members) proves nothing about who voted. */
export function TestModeWarning({ mode }: { mode: EligMode }) {
  const authMode = useAuth()?.authMode;   // no provider (a bare component test) = no warning
  if (authMode !== 'email-demo' || mode === 'all') return null;
  return <div className="admin-banner admin-banner-danger" role="alert">{TEST_MODE_TEXT}</div>;
}

const names = (list: string[]) => list.slice(0, 25).join(', ') + (list.length > 25 ? `, and ${list.length - 25} more` : '');

/** Entries that were skipped or look wrong, and listed addresses nobody has signed in with. Shown to the admin who saved the list. */
export function ListNotes({ invalid = [], notNamra = [], neverSignedIn = [], left = 0 }: { invalid?: string[]; notNamra?: string[]; neverSignedIn?: string[]; left?: number }) {
  const authMode = useAuth()?.authMode;   // no provider (a bare component test) = no warning
  const microsoft = authMode === 'entra';
  if (!invalid.length && !notNamra.length && !neverSignedIn.length && !left) return null;
  return (
    <div className="stack list-notes" role="status">
      {invalid.length > 0 && <p className="admin-banner admin-banner-danger"><strong>{invalid.length} {invalid.length === 1 ? 'entry is' : 'entries are'} not an email address{invalid.length === 1 ? '' : 'es'} and {invalid.length === 1 ? 'was' : 'were'} not saved:</strong> {names(invalid)}</p>}
      {notNamra.length > 0 && <p className="admin-banner"><strong>{notNamra.length} {notNamra.length === 1 ? 'address is' : 'addresses are'} not @{NAMRA_DOMAIN}</strong> (saved, but check {notNamra.length === 1 ? 'it' : 'them'}): {names(notNamra)}</p>}
      {neverSignedIn.length > 0 && <p className="admin-banner"><strong>{neverSignedIn.length} listed {neverSignedIn.length === 1 ? 'address has' : 'addresses have'} never signed in{microsoft ? ' with a Microsoft account' : ''}.</strong> {microsoft ? 'Check the spelling: an address that is not a real account can never vote.' : 'They may not have used this site yet.'} {names(neverSignedIn)}</p>}
      {left > 0 && <p className="field-helper">{left} listed {left === 1 ? 'person has' : 'people have'} left NamRA. They stay on the list, so the eligible count and the quorum do not change.</p>}
    </div>
  );
}

/**
 * Who may vote. Used when creating a campaign and when editing a draft, so both screens offer the same choices and the same wording.
 * It only shows and reports the choice; whoever uses it is responsible for SAVING it (the create form sends it with the campaign).
 */
export function EligibilityPicker({ mode, onMode, text, onText, umojaCount }: {
  mode: EligMode; onMode: (m: EligMode) => void; text: string; onText: (t: string) => void; umojaCount?: number;
}) {
  const name = useId();
  const emails = parseEmails(text);
  const { invalid, notNamra } = checkEmails(emails);
  return (
    <div className="stack">
      <TestModeWarning mode={mode} />
      <label className="check"><input type="radio" name={name} checked={mode === 'umoja'} onChange={() => onMode('umoja')} /> Umoja members only{umojaCount !== undefined ? ` (${umojaCount} active member${umojaCount === 1 ? '' : 's'})` : ''}</label>
      <label className="check"><input type="radio" name={name} checked={mode === 'all'} onChange={() => onMode('all')} /> All signed-in NamRA staff</label>
      <label className="check"><input type="radio" name={name} checked={mode === 'list'} onChange={() => onMode('list')} /> Only these email addresses</label>
      {mode === 'list' && (
        <label>Email addresses<span className="field-helper">One per line, or separated by commas. {emails.length} address{emails.length === 1 ? '' : 'es'}.</span>
          <textarea rows={6} value={text} onChange={(e) => onText(e.target.value)} /></label>
      )}
      {mode === 'list' && <ListNotes invalid={invalid} notNamra={notNamra} />}
    </div>
  );
}
