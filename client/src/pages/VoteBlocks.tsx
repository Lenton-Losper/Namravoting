import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { api, ApiError, fmtDate, type Notice } from '../api';
import { Icon } from '../icons';
import { BackLink, ErrorBox, NoticeBanner, Spinner, initials } from '../ui';

/**
 * The voter's side of a campaign with positions (e.g. "Umoja Committee 2026": Press Secretary, Finance Officer ...).
 *
 *   campaign home   a block per position, with progress; a block that is done is greyed "Voted" with its receipt code.
 *                   A campaign with ONE position skips this screen and opens the ballot directly.
 *   ballot          per position: Step 1 choose (cards; optional region filter; abstain apart) -> Step 2 confirm (a sheet) -> the receipt
 *                   ("Your vote is in", the results date, the receipt code) -> Done goes back to the blocks.
 * Each position is its own vote, in any order; a done position is never opened again (the server refuses its ballot: 409).
 */

export interface AnnouncementInfo { at: string; text: string; positions: { title: string; winners: string[] }[] }
/** The winners, by name, as announced. No votes, no percentages, no turnout. */
export function AnnouncementCard({ a }: { a: AnnouncementInfo }) {
  return (
    <section className="card card-pad announcement" aria-label="Winners">
      <h2>{a.positions.length === 1 ? 'Winner' : 'Winners'}</h2>
      <ul className="list announcement-list">
        {a.positions.map((p, i) => <li key={i}><strong>{p.title}</strong>: {p.winners.length ? p.winners.join(', ') : 'No winner'}</li>)}
      </ul>
      <p className="muted small">Announced on {fmtDate(a.at)}.</p>
    </section>
  );
}
/** What the receipt and the closed screen say about the result: winners are announced, never published as numbers. */
export const winnersLine = (releaseAt: string | null | undefined) => (releaseAt ? `Winners will be announced on ${fmtDate(releaseAt)}.` : 'Winners will be announced after voting closes.');

/** A position's voting rules as the ballot receives them: the pick range and the optional "at least N from outside <region>" rule. */
export interface PickRules { minPicks?: number; maxPicks?: number; chooseLabel?: string; regionRule?: { minOutside: number; regionId: string; regionName: string; text: string } | null }
/** "Choose 4", "Choose up to 4" or "Choose 2 to 4" (the server sends the same text; this is for ballots from before the range existed). */
export const pickLabel = (min: number, max: number) => (min === max ? `Choose ${max}` : min === 1 ? `Choose up to ${max}` : `Choose ${min} to ${max}`);
export interface BlockPosition extends PickRules { id: string; title: string; description: string | null; seats?: number; ruleText?: string | null; voted: boolean; candidateCount: number; receiptCode?: string | null }
export interface BlocksInfo {
  title: string; description: string | null; opensAt: string | null; closesAt: string | null;
  resultsReleaseAt?: string | null; groupByRegion?: boolean;
  /** The winners the creator announced (names only, no counts): present only for people who voted. The only result a voter ever sees. */
  announcement?: AnnouncementInfo | null;
  voterState: 'can_vote' | 'already_voted' | 'not_eligible' | 'not_member' | 'not_open' | 'closed';
  notices?: Notice[]; positions: BlockPosition[]; progress?: { voted: number; total: number };
}
export interface BallotCandidate {
  id: string; name: string; bio: string | null; pledge?: string | null; photoUrl: string | null; isAbstain: boolean; withdrawn: boolean;
  regionId: string | null; region: string | null;
}
interface Ballot {
  position: { id: string; title: string; description: string | null; seats?: number; ruleText?: string | null } & PickRules;
  regions: { id: string; name: string }[]; candidates: BallotCandidate[]; progress: { voted: number; total: number };
  campaign?: { title: string; closesAt: string | null; resultsReleaseAt?: string | null };
  groupByRegion?: boolean;
}

/** Above this many candidates in a position, the cards are compact (photo left, one line of pledge). */
export const COMPACT_ABOVE = 6;
/** Above this many candidates (or when the campaign groups by region), the ballot shows the region filter and groups. */
export const REGIONS_ABOVE = 8;
/** Placeholder until Umoja names its contact for voting questions. */
export const HELP_CONTACT = '[Umoja contact: name, phone or email]';

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
/** The one line on the card: the candidate's pledge, or the start of their bio (about 140 characters, cut at a word). */
export function cardLine(c: Pick<BallotCandidate, 'pledge' | 'bio'>): string {
  const pledge = c.pledge?.trim();
  if (pledge) return pledge;
  const bio = (c.bio ?? '').trim().replace(/\s+/g, ' ');
  if (bio.length <= 140) return bio;
  const cut = bio.slice(0, 140);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 100))}…`;
}

const pendingKey = (token: string, pid: string) => `namra:pending-vote:${token}:${pid}`;
const clearPending = (token: string, pid: string) => { try { sessionStorage.removeItem(pendingKey(token, pid)); } catch { /* storage unavailable */ } };

// ---- building blocks -------------------------------------------------------------------------------------------------------------

/** A full-width state screen in the ballot's style: an icon in a tinted circle, a heading, text and actions. */
export function BallotState({ tone = 'info', icon, title, children, actions }: { tone?: 'info' | 'success' | 'warn'; icon: string; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={`ballot-state ballot-state-${tone}`} aria-live="polite">
      <span className="ballot-state-icon" aria-hidden="true"><Icon name={icon} size={30} /></span>
      <h1 className="ballot-state-title">{title}</h1>
      {children}
      {actions && <div className="ballot-state-actions">{actions}</div>}
    </section>
  );
}

/** A receipt code panel: "Receipt number", the code, and what it proves. */
function ReceiptCode({ code }: { code: string | null | undefined }) {
  if (!code) return null;
  return (
    <div className="receipt-box">
      <span className="receipt-label">Receipt number</span>
      <span className="receipt-code">{code}</span>
      <span className="receipt-note">Proves you voted. It doesn't show who you voted for.</span>
    </div>
  );
}

/** A round photo, or initials when there is none. Decorative (alt=""): the candidate's name is always written next to it, so a screen reader would read it twice. */
function Avatar({ url, name, size }: { url: string | null; name: string; size: 'sm' | 'md' | 'lg' | 'xl' }) {
  return url
    ? <img className={`avatar avatar-${size}`} src={url} alt="" />
    : <span className={`avatar avatar-${size} avatar-empty`} aria-hidden="true">{initials(name)}</span>;
}

/**
 * A bottom sheet (a centred dialog on a wide screen). Focus moves into it, Tab stays inside it, Escape closes it (unless `busy`), and
 * focus goes back to what opened it.
 */
function Sheet({ label, onClose, busy, children, className }: { label: string; onClose: () => void; busy?: boolean; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); useEffect(() => { closeRef.current = onClose; });
  const busyRef = useRef(busy); useEffect(() => { busyRef.current = busy; });
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => { before?.focus?.(); };
  }, []);
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !busyRef.current) { e.stopPropagation(); closeRef.current(); return; }
    if (e.key !== 'Tab' || !ref.current) return;
    const f = [...ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], select, input, textarea, [tabindex]:not([tabindex="-1"])')];
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0]; const last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  return (
    <div className="sheet-backdrop" onClick={() => { if (!busyRef.current) closeRef.current(); }}>
      <div className={`ballot-sheet${className ? ` ${className}` : ''}`} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} ref={ref}
        onKeyDown={onKey} onClick={(e) => e.stopPropagation()}>
        <span className="sheet-handle" aria-hidden="true" />
        {children}
      </div>
    </div>
  );
}

function HelpSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet label="How voting works" onClose={onClose}>
      <h2 className="sheet-title">How voting works</h2>
      <ol className="help-steps">
        <li><strong>Choose</strong> one candidate. Tap a card to select it; tap "Read full statement" to read more first.</li>
        <li><strong>Review</strong> your choice. Nothing is sent until you press "Submit my vote".</li>
        <li><strong>Submit.</strong> You get a receipt number that proves you voted.</li>
      </ol>
      <ul className="help-facts">
        <li><Icon name="lock" size={16} /> Your vote is anonymous: nobody, including the administrators, can see who you voted for.</li>
        <li><Icon name="check" size={16} /> You can vote once in each position, and a vote can't be changed after you submit it.</li>
        <li><Icon name="info" size={16} /> Need help? Contact {HELP_CONTACT}.</li>
      </ul>
      <button type="button" className="ballot-btn ballot-btn-secondary" onClick={onClose}>Close</button>
    </Sheet>
  );
}

function StatementSheet({ c, onChoose, onClose }: { c: BallotCandidate; onChoose: () => void; onClose: () => void }) {
  const id = useId();
  return (
    <Sheet label={`Statement of ${c.name}`} onClose={onClose} className="statement-sheet">
      <div className="statement-head">
        <Avatar url={c.photoUrl} name={c.name} size="xl" />
        <h2 className="sheet-title" id={id}>{c.name}</h2>
        {c.region && <p className="statement-region">{c.region}</p>}
      </div>
      {c.pledge && <p className="statement-pledge">“{c.pledge}”</p>}
      {c.bio ? <p className="statement-bio">{c.bio}</p> : <p className="statement-bio muted">This candidate has not written a statement.</p>}
      {!c.withdrawn && <button type="button" className="ballot-btn ballot-btn-primary" onClick={onChoose}>Choose {firstName(c.name)}</button>}
      <button type="button" className="ballot-btn ballot-btn-secondary" onClick={onClose}>Close</button>
    </Sheet>
  );
}

// ---- one position's ballot ---------------------------------------------------------------------------------------------------------

type Step = 'choose' | 'confirm' | 'receipt';

/** Step 1 (choose) -> Step 2 (confirm sheet) -> the receipt. `single` = the campaign has one position (no "All positions" link). */
export function PositionBallot({ token, position, campaign, single, onBack, onDone }: {
  token: string; position: { id: string; title: string }; single?: boolean;
  campaign: { title: string; closesAt: string | null; resultsReleaseAt?: string | null };
  onBack: () => void; onDone: () => void;
}) {
  const [ballot, setBallot] = useState<Ballot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [region, setRegion] = useState('');
  const [picked, setPicked] = useState<string[]>([]);   // one id for a one-seat position, up to `seats` for a choose-N position (or the Abstain line alone)
  const [step, setStep] = useState<Step>('choose');
  const [receipt, setReceipt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [statement, setStatement] = useState<BallotCandidate | null>(null);
  const [help, setHelp] = useState(false);
  const submitting = useRef(false);   // synchronous guard: a double tap can never send two requests
  const restored = useRef(false);     // a pick came back from before a re-sign-in: scroll it into view once the ballot is shown
  const [dropped, setDropped] = useState<string | null>(null);   // a selected candidate who has since withdrawn, removed from the selection
  const url = `/api/vote/${token}/positions/${position.id}`;

  const load = useCallback(async (): Promise<Ballot | 'gone' | null> => {
    try { const b = await api<Ballot>('GET', url); setBallot(b); setError(null); return b; }
    catch (e) {
      // Already voted here / closed / not open: this ballot is not available; the campaign page shows the true state.
      if (e instanceof ApiError && [403, 404, 409].includes(e.status)) return 'gone';
      setError((e as Error).message); return null;
    }
  }, [url]);
  useEffect(() => { void load().then((b) => { if (b === 'gone') onBack(); }); }, [load, onBack]);
  // Back from a re-sign-in with the choice kept: restore it (once). The person still reviews and submits.
  useEffect(() => {
    let id: string | null = null;
    try { id = sessionStorage.getItem(pendingKey(token, position.id)); sessionStorage.removeItem(pendingKey(token, position.id)); } catch { /* storage unavailable */ }
    if (id) { restored.current = true; setPicked(id.split(',').filter(Boolean)); }
  }, [token, position.id]);

  const all = ballot?.candidates ?? [];
  const people = all.filter((c) => !c.isAbstain);
  const abstain = all.find((c) => c.isAbstain);
  const compact = people.length > COMPACT_ABOVE;
  const showRegions = !!ballot && (!!ballot.groupByRegion || people.length > REGIONS_ABOVE);
  // Regions that actually have candidates, in the campaign's order. Candidates with no region are listed WITHOUT any heading.
  const regionsUsed = useMemo(() => (ballot?.regions ?? []).filter((r) => people.some((c) => c.regionId === r.id)), [ballot, people]);
  const visible = useMemo(() => (showRegions && region ? people.filter((c) => c.regionId === region) : people), [people, region, showRegions]);
  const seats = Math.max(1, ballot?.position.seats ?? 1);
  // How many a voter may pick: the range (older ballots: exactly `seats`). The region rule, when there is one, is counted on what is picked.
  const minP = Math.max(1, ballot?.position.minPicks ?? seats);
  const maxP = Math.max(minP, ballot?.position.maxPicks ?? seats);
  const multi = maxP > 1;
  const rule = ballot?.position.regionRule ?? null;
  const label = ballot?.position.chooseLabel ?? pickLabel(minP, maxP);
  const [blockedMsg, setBlockedMsg] = useState<string | null>(null);
  // A choice that the filter hides, that no longer exists, or that has WITHDRAWN is dropped, so nobody confirms a candidate they cannot see or cannot choose.
  useEffect(() => {
    if (!ballot) return;
    const gone = picked.map((id) => all.find((c) => c.id === id)).filter((c) => c?.withdrawn);
    setPicked((cur) => { const keep = cur.filter((id) => id === abstain?.id || (visible.some((c) => c.id === id) && !all.find((c) => c.id === id)?.withdrawn)); return keep.length === cur.length ? cur : keep; });
    if (gone.length) setDropped(gone.map((c) => c!.name).join(', '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, ballot, abstain]);
  const chosen = picked.map((id) => all.find((c) => c.id === id)).filter((c): c is BallotCandidate => !!c);   // in the order they were picked
  const abstaining = chosen.length === 1 && chosen[0].isAbstain;
  const pickedPeople = chosen.filter((c) => !c.isAbstain).length;
  const full = multi && pickedPeople >= maxP;
  // Region rule: candidates a voter can still choose outside the region cap what the rule can ask for (a withdrawal must not lock everybody out).
  const outsideAvailable = rule ? people.filter((c) => !c.withdrawn && c.regionId !== rule.regionId).length : 0;
  const needOutside = rule ? Math.min(rule.minOutside, outsideAvailable) : 0;
  const pickedOutside = rule ? chosen.filter((c) => !c.isAbstain && c.regionId !== rule.regionId).length : 0;
  const stillOutside = Math.max(0, needOutside - pickedOutside);
  const ruleOk = stillOutside === 0;
  const countOk = pickedPeople >= minP && pickedPeople <= maxP;
  /** One more pick from INSIDE the region would leave too few places for the outside picks the rule still needs. */
  const wouldBreakRule = (c: BallotCandidate) => !!rule && !c.isAbstain && c.regionId === rule.regionId && !picked.includes(c.id) && stillOutside > maxP - pickedPeople - 1;
  /** Scroll a chosen card to the middle of the screen and give it focus, so what the footer names can always be found. */
  const jumpTo = useCallback((id: string) => {
    const li = document.getElementById(`cand-${id}`) ?? null;
    if (!li) return;
    const calm = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    li.scrollIntoView?.({ block: 'center', behavior: calm ? 'auto' : 'smooth' });
    (li.querySelector('.ballot-card-main') as HTMLElement | null)?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (!ballot || !restored.current || picked.length === 0) return;
    restored.current = false;
    const id = window.setTimeout(() => jumpTo(picked[0]), 0);   // after the cards are in the page
    return () => window.clearTimeout(id);
  }, [ballot, picked, jumpTo]);
  const ready = abstaining || (countOk && ruleOk);
  /** One tap on a card. One seat: it becomes the choice. Several seats: it is added, or taken off again; nothing more once `seats` are picked. */
  function toggle(c: BallotCandidate) {
    if (c.withdrawn) return;
    if (wouldBreakRule(c)) { setBlockedMsg(`You can't add another ${rule!.regionName} candidate: you still need ${stillOutside} from outside ${rule!.regionName} and only ${Math.max(0, maxP - pickedPeople)} place${maxP - pickedPeople === 1 ? ' is' : 's are'} left. Unselect a ${rule!.regionName} candidate, or pick from another region.`); return; }
    setBlockedMsg(null);
    setPicked((cur) => {
      if (!multi) return [c.id];
      if (c.isAbstain) return cur.includes(c.id) ? [] : [c.id];       // Abstain stands alone
      const people = cur.filter((id) => id !== abstain?.id);
      if (people.includes(c.id)) return people.filter((id) => id !== c.id);
      return people.length >= maxP ? people : [...people, c.id];
    });
  }

  async function submit() {
    if (!ready || submitting.current) return;
    submitting.current = true; setBusy(true);
    try { sessionStorage.setItem(pendingKey(token, position.id), picked.join(',')); } catch { /* storage unavailable */ }
    try {
      const r = await api<{ recorded: boolean; receiptCode?: string }>('POST', url, multi || picked.length > 1 ? { candidateIds: picked } : { candidateId: picked[0] });
      clearPending(token, position.id);
      setPicked([]);                                       // the chosen candidates are intentionally NOT kept on screen
      setReceipt(r.receiptCode ?? null); setStep('receipt');
    } catch (e) {
      setStep('choose');
      if (e instanceof ApiError && e.status === 401) return;   // being signed back in; the ballot comes back with the choice selected
      clearPending(token, position.id);
      if (e instanceof ApiError && [403, 404, 409].includes(e.status)) { setPicked([]); onBack(); }   // definitive: show the true state
      else {
        // Network or server error: the outcome is unknown. Ask the server; if the vote landed this ballot is "already voted" (409).
        const fresh = await load();
        if (fresh === 'gone') onBack();
        else if (!fresh) setUncertain(true);                                // could not even ask: do NOT invite a second attempt yet
        else setError('Your vote was not recorded. Please try again.');     // the server says there is no receipt, so voting again is safe
      }
    } finally { submitting.current = false; setBusy(false); }
  }
  async function recheck() {
    const fresh = await load();
    if (fresh === 'gone') { onBack(); return; }
    if (!fresh) return;
    setUncertain(false); setError('Your vote was not recorded. You can vote again.');
  }

  const release = campaign.resultsReleaseAt ?? ballot?.campaign?.resultsReleaseAt ?? null;
  // The Help button lives in the white top bar (right side, 44x44) when the page has one; without a bar it sits beside the back link.
  const [helpSlot, setHelpSlot] = useState<HTMLElement | null>(null);
  useEffect(() => { setHelpSlot(document.getElementById('topbar-help')); }, []);
  const helpButton = <button type="button" className="help-button" aria-label="Help: how voting works" onClick={() => setHelp(true)}><Icon name="help" size={22} /></button>;

  if (step === 'receipt') {
    return (
      <div className="ballot-screen ballot-screen-receipt">
        <BallotState tone="success" icon="check" title="Your vote is in"
          actions={<button type="button" className="ballot-btn ballot-btn-primary" onClick={onDone}>Done</button>}>
          <p className="ballot-state-text">Thank you for voting. {winnersLine(release)}</p>
          <ReceiptCode code={receipt} />
        </BallotState>
      </div>
    );
  }

  const card = (c: BallotCandidate) => {
    const on = picked.includes(c.id);
    const line = cardLine(c);
    const dimmed = full && !on && !c.withdrawn;   // the limit is reached: the other cards cannot be added until one is taken off
    const blocked = !dimmed && !on && !c.withdrawn && wouldBreakRule(c);   // greyed out, but a tap explains why
    return (
      <li key={c.id} id={`cand-${c.id}`} className={`ballot-card${on ? ' is-selected' : ''}${compact ? ' is-compact' : ''}${c.withdrawn ? ' is-withdrawn' : ''}${dimmed ? ' is-dimmed' : ''}${blocked ? ' is-blocked' : ''}`}>
        <button type="button" className="ballot-card-main" aria-pressed={on} aria-disabled={blocked || undefined} disabled={c.withdrawn || dimmed} onClick={() => toggle(c)}>
          <span className={`ballot-radio${multi ? ' is-check' : ''}`} aria-hidden="true">{on && (multi ? <Icon name="check" size={16} /> : <span className="ballot-radio-dot" />)}</span>
          <Avatar url={c.photoUrl} name={c.name} size={compact ? 'sm' : 'lg'} />
          <span className="ballot-card-text">
            <span className="ballot-card-name"><strong>{c.name}</strong>{c.region && <span className="ballot-card-region"> – {c.region}</span>}</span>
            {c.withdrawn ? <span className="ballot-card-line">Withdrawn: this candidate can no longer be chosen</span> : line && <span className="ballot-card-line">{line}</span>}
          </span>
          {on && <span className="sr-only">Selected</span>}
        </button>
        {(c.bio || c.pledge) && (
          <button type="button" className="statement-link" onClick={() => setStatement(c)} aria-label={`Read full statement of ${c.name}`}>
            Read full statement <Icon name="chevron" size={16} />
          </button>
        )}
      </li>
    );
  };

  const groups = showRegions && !region
    ? [...regionsUsed.map((r) => ({ key: r.id, name: r.name as string | null, items: visible.filter((c) => c.regionId === r.id) })),
       { key: 'none', name: null, items: visible.filter((c) => !c.regionId || !regionsUsed.some((r) => r.id === c.regionId)) }].filter((g) => g.items.length)
    : [{ key: 'all', name: null as string | null, items: visible }];

  return (
    <div className="ballot-screen">
      <div className="ballot-topline">
        {single ? <BackLink to="/votes">My votes</BackLink> : <button type="button" className="back-link back-button" onClick={onBack}>← All positions</button>}
        {!helpSlot && helpButton}
      </div>
      {helpSlot && createPortal(helpButton, helpSlot)}
      <p className="ballot-eyebrow">{campaign.title}</p>
      <p className="ballot-step">Step 1 of 2 · {multi ? label : 'Choose'}</p>
      <h1 className="ballot-title">{position.title}</h1>
      {ballot?.position.ruleText && <p className="rule-text"><Icon name="info" size={16} /> <span>{ballot.position.ruleText}</span></p>}
      {rule && <p className="rule-text region-rule-text"><Icon name="info" size={16} /> <span>{rule.text}</span></p>}
      <div className="ballot-chips">
        {campaign.closesAt && <span className="ballot-chip"><Icon name="clock" size={14} /> Closes {fmtDate(campaign.closesAt)}</span>}
        <span className="ballot-chip"><Icon name="lock" size={14} /> Your vote is anonymous</span>
      </div>
      {ballot?.position.description && <p className="ballot-intro">{ballot.position.description}</p>}
      <p className="ballot-intro" role={multi ? 'status' : undefined}>
        {!multi ? "Pick one candidate. You'll see your choice again before anything is submitted."
          : full ? `You've picked ${maxP} of ${maxP}. Unselect one to change.`
          : minP === maxP ? `Pick exactly ${maxP} candidates. You'll see your choices again before anything is submitted.`
          : `Pick ${minP === 1 ? 'up to' : `${minP} to`} ${maxP} candidates. You'll see your choices again before anything is submitted.`}
      </p>
      <ErrorBox message={uncertain ? null : error} />   {/* the "may not have been recorded" screen says it better */}
      {!ballot && !error && !uncertain && <Spinner />}
      {uncertain && (
        <BallotState tone="warn" icon="alert" title="Your vote may not have been recorded"
          actions={<><button type="button" className="ballot-btn ballot-btn-primary" onClick={() => void recheck()}>Check again</button><button type="button" className="ballot-btn ballot-btn-secondary" onClick={onBack}>Back</button></>}>
          <p className="ballot-state-text">The connection dropped before we heard back, and we could not reach the server to check. Please do not vote again until you have checked: press “Check again”.</p>
        </BallotState>
      )}
      {ballot && !uncertain && (
        <>
          {showRegions && (
            <div className="region-filter">
              <label>Region
                <select value={region} onChange={(e) => setRegion(e.target.value)} aria-describedby="region-count">
                  <option value="">All regions</option>
                  {regionsUsed.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
              <p id="region-count" className="muted small" role="status">{region ? `Showing ${visible.length} of ${people.length} candidates` : `${people.length} candidates`}</p>
            </div>
          )}
          <div className="ballot-list">
            {groups.map((g) => (
              <section key={g.key} className="ballot-group" aria-label={g.name ?? undefined}>
                {g.name && <h2 className="region-heading">{g.name} <span className="muted count">({g.items.length})</span></h2>}
                <ul className="ballot-cards">{g.items.map(card)}</ul>
              </section>
            ))}
          </div>
          {abstain && (
            <div className="abstain-block">
              <p className="abstain-or">Or, if you don't want to choose a candidate:</p>
              <button type="button" className={`abstain-option${picked.includes(abstain.id) ? ' is-selected' : ''}`} aria-pressed={picked.includes(abstain.id)} onClick={() => toggle(abstain)}>
                <span className="ballot-radio" aria-hidden="true">{picked.includes(abstain.id) && <span className="ballot-radio-dot" />}</span>
                <span><strong>Abstain</strong> (none of the above)<span className="abstain-note">{multi ? `Counts as a vote cast, for no candidate, in all ${minP} places.` : 'Counts as a vote cast, for no candidate.'}</span></span>
              </button>
            </div>
          )}
          <div className="ballot-footer">
            {dropped && <p className="ballot-footer-hint" role="status">{dropped} has withdrawn and was removed from your selection.</p>}
            {rule && !abstaining && (
              <p className={`region-counter${ruleOk ? ' is-met' : ''}`} role="status" data-testid="region-counter">
                Outside {rule.regionName}: {pickedOutside} of {needOutside} needed{ruleOk ? ' ✓' : ''}
              </p>
            )}
            {blockedMsg && <p className="ballot-footer-hint region-blocked-msg" role="alert">{blockedMsg}</p>}
            {chosen.length > 0 && !abstaining && (
              <p className="ballot-selected">Selected:{' '}
                {chosen.map((c, i) => (
                  <span key={c.id}>{i > 0 && ', '}<button type="button" className="ballot-selected-link" onClick={() => jumpTo(c.id)} aria-label={`Selected: ${c.name}. Show this card`}>{c.name}</button></span>
                ))}
              </p>
            )}
            {ready
              ? <button type="button" className="ballot-btn ballot-btn-primary" onClick={() => setStep('confirm')}>
                  {abstaining ? 'Review: abstain' : multi ? `Review ${pickedPeople} vote${pickedPeople === 1 ? '' : 's'}` : `Review vote for ${chosen[0].name}`}
                </button>
              : multi
                ? <>
                    <button type="button" className="ballot-btn ballot-btn-primary" disabled>{pickedPeople === 0 ? (minP === maxP ? `Select ${maxP} candidates` : `Select ${minP === 1 ? 'up to ' : `${minP} to `}${maxP} candidates`) : minP === maxP ? `${pickedPeople} of ${maxP} selected` : `${pickedPeople} selected`}</button>
                    {!countOk && pickedPeople > 0 && pickedPeople < minP && <p className="ballot-footer-hint">Pick at least {minP} candidates to continue.</p>}
                    {rule && !ruleOk && !abstaining && <p className="ballot-footer-hint region-needed" role="status">Pick {stillOutside} more from outside {rule.regionName} to continue.</p>}
                  </>
                : <><button type="button" className="ballot-btn ballot-btn-primary" disabled>Review vote</button><p className="ballot-footer-hint">Select a candidate to continue</p></>}
          </div>
        </>
      )}

      {step === 'confirm' && ready && (
        <Sheet label="Confirm your vote" onClose={() => setStep('choose')} busy={busy}>
          <p className="ballot-step">Step 2 of 2 · Confirm</p>
          <h2 className="sheet-title">Confirm your vote</h2>
          <div className="confirm-choices">
            {chosen.map((c) => (
              <div className="confirm-choice" key={c.id}>
                {c.isAbstain
                  ? <span className="confirm-text"><strong>Abstain</strong><span>{position.title}: none of the above</span></span>
                  : <><Avatar url={c.photoUrl} name={c.name} size="md" /><span className="confirm-text"><strong>{c.name}</strong><span>{[position.title, c.region].filter(Boolean).join(' · ')}</span></span></>}
              </div>
            ))}
          </div>
          <p className="confirm-warning"><Icon name="alert" size={20} /> <span>Once you submit, your vote can't be changed.</span></p>
          <button type="button" className="ballot-btn ballot-btn-primary ballot-btn-submit" disabled={busy} onClick={() => void submit()}>{busy ? 'Submitting…' : 'Submit my vote'}</button>
          <button type="button" className="ballot-btn ballot-btn-secondary" disabled={busy} onClick={() => setStep('choose')}>Change my choice</button>
        </Sheet>
      )}
      {statement && <StatementSheet c={statement} onClose={() => setStatement(null)} onChoose={() => { if (!picked.includes(statement.id)) toggle(statement); setRegion((r) => (r && statement.regionId !== r ? '' : r)); setStatement(null); }} />}
      {help && <HelpSheet onClose={() => setHelp(false)} />}
    </div>
  );
}

// ---- the campaign home ------------------------------------------------------------------------------------------------------------

/** The campaign home: a block per position (or, with one position, the ballot itself), and the states around it. */
export function CampaignBlocks({ token, info, reload }: { token: string; info: BlocksInfo; now?: Date; reload: () => Promise<unknown> }) {
  const [open, setOpen] = useState<{ id: string; title: string } | null>(null);

  const total = info.positions.length;
  const voted = info.positions.filter((p) => p.voted).length;
  const single = total === 1;
  const back = useCallback(() => { setOpen(null); void reload(); }, [reload]);
  const campaign = { title: info.title, closesAt: info.closesAt, resultsReleaseAt: info.resultsReleaseAt ?? null };
  const goVotes = <Link className="ballot-btn ballot-btn-secondary" to="/votes">Go to My votes</Link>;

  const announced = info.announcement ? <AnnouncementCard a={info.announcement} /> : null;

  if (info.voterState === 'can_vote') {
    // One position: straight to its ballot. Several: the chosen block's ballot.
    const target = open ?? (single && !info.positions[0].voted ? { id: info.positions[0].id, title: info.positions[0].title } : null);
    if (target) {
      return (
        <>
          <NoticeBanner notices={info.notices} />
          <PositionBallot key={target.id} token={token} position={target} campaign={campaign} single={single} onBack={back} onDone={back} />
        </>
      );
    }
  }

  if (info.voterState === 'not_open') {
    return <div className="ballot-screen"><p className="ballot-eyebrow">{info.title}</p><BallotState icon="clock" title="Voting hasn't opened yet" actions={goVotes}><p className="ballot-state-text">{info.opensAt ? `Voting opens ${fmtDate(info.opensAt)}. Come back then.` : 'Please check back soon.'}</p></BallotState></div>;
  }
  if (info.voterState === 'closed') {
    return (
      <div className="ballot-screen">
        <p className="ballot-eyebrow">{info.title}</p>
        <BallotState icon="lock" title="Voting has closed" actions={goVotes}>
          <p className="ballot-state-text">{info.announcement ? 'The winners are announced below.' : winnersLine(info.resultsReleaseAt)}</p>
        </BallotState>
        <NoticeBanner notices={info.notices} />
        {announced}
      </div>
    );
  }
  if (info.voterState === 'already_voted' && single) {
    const p = info.positions[0];
    return (
      <div className="ballot-screen">
        <p className="ballot-eyebrow">{info.title}</p>
        <BallotState tone="success" icon="check" title="You've already voted" actions={goVotes}>
          <p className="ballot-state-text">Your vote for {p.title} is recorded and can't be changed. {winnersLine(info.resultsReleaseAt)}</p>
          <ReceiptCode code={p.receiptCode} />
        </BallotState>
      </div>
    );
  }

  return (
    <div className="ballot-screen">
      <BackLink to="/votes">Back to My votes</BackLink>
      <p className="ballot-eyebrow">{info.title}</p>
      <h1 className="ballot-title">{info.voterState === 'already_voted' ? "You've voted in every position" : 'Choose a position to vote in'}</h1>
      <div className="ballot-chips">
        {info.closesAt && <span className="ballot-chip"><Icon name="clock" size={14} /> Closes {fmtDate(info.closesAt)}</span>}
        <span className="ballot-chip"><Icon name="lock" size={14} /> Your vote is anonymous</span>
      </div>
      {info.description && <p className="ballot-intro">{info.description}</p>}
      <NoticeBanner notices={info.notices} />
      <p className="vote-progress" role="status"><strong>{voted} of {total}</strong> position{total === 1 ? '' : 's'} voted</p>
      {info.voterState === 'can_vote' && <p className="ballot-intro">You can vote in the positions in any order, and each vote is separate.</p>}
      <ul className="position-grid" aria-label="Positions">
        {info.positions.map((p) => (
          <li key={p.id}>
            <button type="button" className={`position-block${p.voted ? ' position-voted' : ''}`} disabled={p.voted || info.voterState !== 'can_vote'}
              onClick={() => setOpen({ id: p.id, title: p.title })}
              aria-label={p.voted ? `${p.title}: voted${p.receiptCode ? `, receipt ${p.receiptCode}` : ''}` : `${p.title}: ${p.candidateCount} candidates, not voted yet`}>
              <span className="position-title">{p.title}</span>
              {p.description && <span className="muted small excerpt">{p.description}</span>}
              {p.ruleText && <span className="rule-text"><Icon name="info" size={16} /> <span>{p.ruleText}</span></span>}
              {((p.maxPicks ?? p.seats ?? 1) > 1) && !p.voted && <span className="muted small">{p.chooseLabel ?? pickLabel(p.minPicks ?? p.seats ?? 1, p.maxPicks ?? p.seats ?? 1)}</span>}
              {p.regionRule && !p.voted && <span className="muted small">{p.regionRule.text}</span>}
              {p.voted
                ? <><span className="chip chip-closed position-status"><Icon name="check" size={14} /> Voted</span>{p.receiptCode && <span className="position-receipt">Receipt {p.receiptCode}</span>}</>
                : <span className="chip chip-open position-status">{p.candidateCount} candidate{p.candidateCount === 1 ? '' : 's'}</span>}
            </button>
          </li>
        ))}
      </ul>
      {announced}
    </div>
  );
}
