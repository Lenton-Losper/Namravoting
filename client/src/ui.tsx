import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { fmtDate, type EditChange, type Notice, type PositionResult, type Results } from './api';
import { Icon } from './icons';

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return <p className="muted center pad" role="status">{label}</p>;
}

export function ErrorBox({ message, onRetry }: { message: string | null; onRetry?: () => void }) {
  if (!message) return null;
  return (
    <div className="error" role="alert">
      <p style={{ margin: 0 }}>{message}</p>
      {onRetry && <button type="button" className="btn btn-secondary" style={{ marginTop: 8 }} onClick={onRetry}>Retry</button>}
    </div>
  );
}

/** Small outlined chips: Draft = grey, Open = orange text on orange-50, Closed = navy text on muted surface. */
export function StatusBadge({ status }: { status: 'draft' | 'open' | 'closed' }) {
  return <span className={`chip chip-${status}`}>{status.charAt(0).toUpperCase() + status.slice(1)}</span>;
}

export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return <Link className="back-link" to={to}>← {children}</Link>;
}

export function PageTitle({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="page-title"><h1>{title}</h1>{children && <div className="page-title-actions">{children}</div>}</div>;
}

/** Section heading with a small orange outline icon. */
export function SectionTitle({ icon, children, actions }: { icon: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="section-title">
      <h2><span className="orange-icon"><Icon name={icon} /></span>{children}</h2>
      {actions && <div className="section-actions">{actions}</div>}
    </div>
  );
}

/** label / helper / value group, as in NamRA Connect. */
export function Field({ label, helper, children }: { label: string; helper?: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      {helper && <div className="field-helper">{helper}</div>}
      <div className="field-value">{children}</div>
    </div>
  );
}

/** Text tabs: active = navy 600 with a 2px orange underline. Arrow keys move between tabs. Renders the active panel. */
export function Tabs<T extends string>({ tabs, value, onChange, label, children, flush = false }: {
  tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (id: T) => void; label: string; children: ReactNode; flush?: boolean;
}) {
  const base = useId();
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === value);
    const next = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length : -1;
    if (next < 0) return;
    e.preventDefault(); onChange(tabs[next].id);
    document.getElementById(`${base}-${tabs[next].id}`)?.focus();
  };
  return (
    <>
      <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKey}>
        {tabs.map((t) => (
          <button key={t.id} id={`${base}-${t.id}`} role="tab" aria-selected={value === t.id} aria-controls={`${base}-panel`}
            tabIndex={value === t.id ? 0 : -1} className="tab" onClick={() => onChange(t.id)}>
            {t.label}{t.count !== undefined && <span className="tab-count">({t.count})</span>}
          </button>
        ))}
      </div>
      <div id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-${value}`} className={flush ? '' : 'tabpanel'}>{children}</div>
    </>
  );
}

// ---- what every modal (Dialog here, the ballot's Sheet) shares ---------------------------------------------------------------------------

let scrollLocks = 0;
let savedBody: { overflow: string; paddingRight: string } | null = null;
/**
 * Stops the page behind a modal from scrolling, and puts everything back when the LAST open modal closes (a count, so two modals at once are
 * safe). The width of the vanished scrollbar is added as padding so the page does not jump sideways.
 */
export function lockBodyScroll(): () => void {
  if (scrollLocks++ === 0) {
    const b = document.body;
    const bar = window.innerWidth - document.documentElement.clientWidth;
    savedBody = { overflow: b.style.overflow, paddingRight: b.style.paddingRight };
    b.style.overflow = 'hidden';
    if (bar > 0) b.style.paddingRight = `${bar}px`;
  }
  let released = false;
  return () => {
    if (released) return; released = true;
    if (--scrollLocks === 0 && savedBody) { document.body.style.overflow = savedBody.overflow; document.body.style.paddingRight = savedBody.paddingRight; savedBody = null; }
  };
}

const FOCUSABLE = 'button:not([disabled]), a[href], select:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal behaviour in one place: focus moves into the modal and goes back to what opened it, the page behind cannot scroll, Escape closes
 * (unless `escapeEnabled` is false, e.g. while saving), and Tab / Shift+Tab stay inside. Returns the keydown handler for the modal's element.
 * The Escape handler is kept in a ref so callers may pass a fresh arrow function on every render without re-running the effect (which
 * would pull focus back to the box after every keystroke typed in a field).
 */
export function useModal(ref: { current: HTMLElement | null }, onEscape: () => void, escapeEnabled = true) {
  const escRef = useRef(onEscape); const enabled = useRef(escapeEnabled);
  useEffect(() => { escRef.current = onEscape; enabled.current = escapeEnabled; });
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const unlock = lockBodyScroll();
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape' && enabled.current) escRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); unlock(); before?.focus?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Tab' || !ref.current) return;
    const f = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1], at = document.activeElement;
    if (e.shiftKey && (at === first || at === ref.current || !ref.current.contains(at))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (at === last || !ref.current.contains(at))) { e.preventDefault(); first.focus(); }
  };
}

/** True while `el` has more content than fits (so its scrolling area can be reached from the keyboard). */
export function useOverflows(el: { current: HTMLElement | null }): boolean {
  const [over, setOver] = useState(false);
  useEffect(() => {
    const node = el.current; if (!node) return;
    const check = () => setOver(node.scrollHeight > node.clientHeight + 1);
    check();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(check) : null;
    ro?.observe(node); window.addEventListener('resize', check);
    return () => { ro?.disconnect(); window.removeEventListener('resize', check); };
  }, [el]);
  return over;
}

/**
 * Accessible modal / bottom sheet. The title bar and the Save / Cancel footer stay in view; only the body between them scrolls (max height
 * 90% of the screen, all of it on a phone), the page behind is locked, focus stays inside, Escape and a click on the backdrop close it.
 */
export function Dialog(props: {
  title: string; children: ReactNode; confirmLabel: string; cancelLabel?: string; busy?: boolean; danger?: boolean;
  hideConfirm?: boolean; confirmDisabled?: boolean; className?: string; onConfirm: () => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const onKeyDown = useModal(ref, props.onCancel);
  const scrolls = useOverflows(bodyRef);
  return (
    <div className="backdrop" onClick={props.onCancel}>
      <div className={`sheet${props.className ? ` ${props.className}` : ''}`} role="dialog" aria-modal="true" aria-label={props.title} tabIndex={-1} ref={ref} onKeyDown={onKeyDown} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head"><h2>{props.title}</h2></div>
        <div className="sheet-body" ref={bodyRef} tabIndex={scrolls ? 0 : undefined} aria-label={scrolls ? `${props.title}: scrollable content` : undefined} role={scrolls ? 'region' : undefined}>{props.children}</div>
        <div className="row sheet-foot">
          <button className="btn btn-secondary" onClick={props.onCancel} disabled={props.busy}>{props.cancelLabel ?? 'Cancel'}</button>
          {!props.hideConfirm && (
            <button className={`btn ${props.danger ? 'btn-danger' : 'btn-primary'}`} onClick={props.onConfirm} disabled={props.busy || props.confirmDisabled}>
              {props.busy ? 'Working…' : props.confirmLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** One post-start edit in words, e.g. "closing time changed from 12 Nov, 17:00 to 12 Nov, 18:00". Titles and candidate names are public anyway. */
export function describeEdit(ch: EditChange): string {
  const q = (v: string | null | undefined) => (v ? `“${v}”` : 'empty');
  switch (ch.what) {
    case 'title': return `title changed from ${q(ch.from)} to ${q(ch.to)}`;
    case 'description': return 'description changed';
    case 'closes_at': return `closing time changed from ${ch.from ? fmtDate(ch.from) : 'none'} to ${ch.to ? fmtDate(ch.to) : 'none'}`;
    case 'candidate_added': return `candidate added: ${ch.name ?? ''}`;
    case 'candidate_removed': return `candidate removed: ${ch.name ?? ''}`;
    case 'position_title': return `position title changed from ${q(ch.from)} to ${q(ch.to)}`;
    case 'position_description': return `description of the position “${ch.name ?? ''}” changed`;
    default: return ch.from && ch.to ? `candidate renamed from ${ch.from} to ${ch.to}` : `candidate edited: ${ch.name ?? ''}`;
  }
}

/** What happened to this vote, in order: resets and early closes, each with who, when and why. Counts only, never voter data. */
export function NoticeList({ notices, title = 'What happened during this vote' }: { notices: Notice[] | undefined; title?: string }) {
  if (!notices?.length) return null;
  return (
    <section className="reset-history" aria-label={title}>
      <h3>{title}</h3>
      <ul className="list">
        {notices.map((x, i) => (
          <li key={i} className="reset-item">
            <div><strong>{fmtDate(x.at)}</strong>{x.by ? ` · ${x.by}` : ''} · {x.kind === 'reset' ? (x.votes_cleared === undefined ? 'reset: all votes were cleared' : `reset: ${x.votes_cleared} ${x.votes_cleared === 1 ? 'vote' : 'votes'} cleared`) : x.kind === 'edited_after_start' ? 'Edited after start' : x.kind === 'candidate_withdrawn' ? `${x.candidate} withdrew (votes already cast for them are void)` : 'closed early'}</div>
            {x.kind === 'edited_after_start'
              ? <ul className="list small">{(x.changes ?? []).map((ch, j) => <li key={j} className="muted">{describeEdit(ch)}</li>)}</ul>
              : <div className="muted small">Reason: {x.reason}</div>}
            {x.candidates && x.candidates.length > 0 && <div className="muted small">Before the reset: {x.candidates.map((c) => `${c.position ? `${c.position}: ` : ''}${c.name} ${c.votes}`).join(' · ')}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Voter-visible banner for the latest reset or early close: "This vote was reset on … because …". */
export function NoticeBanner({ notices }: { notices: Notice[] | undefined }) {
  if (!notices?.length) return null;
  return (
    <div className="notice-banner" role="status">
      {notices.map((x, i) => (
        x.kind === 'candidate_withdrawn'
          ? <p key={i}><strong>{x.candidate} withdrew on {fmtDate(x.at)}</strong> because: {x.reason}. They can no longer be chosen, and votes already cast for them are void.</p>
          : x.kind === 'edited_after_start'
          ? <p key={i}><strong>This vote was edited after it started, on {fmtDate(x.at)}:</strong> {(x.changes ?? []).map(describeEdit).join('; ')}.</p>
          : <p key={i}>
              <strong>This vote was {x.kind === 'reset' ? 'reset' : 'closed early'} on {fmtDate(x.at)}</strong>
              {x.kind === 'reset' ? ' (all earlier votes were cleared and everyone may vote again)' : ''} because: {x.reason}
            </p>
      ))}
    </div>
  );
}

/** Thin turnout bar + "x of y". Uses <progress> (no inline styles, strict CSP). */
export function TurnoutBar({ votes, eligible }: { votes: number; eligible: number | null }) {
  if (eligible === null) return <span className="turnout-text"><strong>{votes}</strong> {votes === 1 ? 'vote' : 'votes'}</span>;
  return (
    <div className="turnout">
      <progress max={Math.max(1, eligible)} value={Math.min(votes, Math.max(1, eligible))} aria-label={`${votes} of ${eligible} voted`} />
      <span className="turnout-text"><strong>{votes}</strong> of {eligible}</span>
    </div>
  );
}

/** Horizontal results bars: navy, leader in orange. */
export function quorumLine(q: { percent: number; eligible: number | null; needed: number | null; votes: number; met: boolean | null }): string {
  return q.met === null ? `Quorum: ${q.percent}% of the eligible voters (their number is not known).`
    : q.met ? `Quorum met: ${q.votes} of the ${q.needed} votes needed (${q.percent}% of ${q.eligible} eligible voters).`
      : `Quorum NOT met: only ${q.votes} of the ${q.needed} votes needed (${q.percent}% of ${q.eligible} eligible voters). This result is below the minimum turnout.`;
}

export function ResultsChart({ candidates, turnout, tie, quorum }: {
  candidates: { id: string; name: string; votes: number; is_abstain?: boolean; withdrawn?: boolean }[]; turnout: { votes: number; eligible: number | null }; tie?: { names: string[]; votes: number } | null;
  quorum?: { percent: number; eligible: number | null; needed: number | null; votes: number; met: boolean | null } | null;
}) {
  const total = Math.max(1, turnout.votes);
  const abstain = candidates.find((c) => c.is_abstain);
  const withdrawn = candidates.filter((c) => c.withdrawn && !c.is_abstain);
  candidates = candidates.filter((c) => !c.is_abstain && !c.withdrawn);
  const top = Math.max(0, ...candidates.map((c) => c.votes));
  return (
    <div className="results">
      <div className="results-turnout">
        <div className="field-label">Turnout</div>
        <TurnoutBar votes={turnout.votes} eligible={turnout.eligible} />
      </div>
      {quorum && <p className={quorum.met === false ? 'tie-note quorum-bad' : 'muted small'} role="status">{quorumLine(quorum)}</p>}
      {tie && <p className="tie-note" role="status"><strong>Tie for first place:</strong> {tie.names.join(' and ')} each have {tie.votes} {tie.votes === 1 ? 'vote' : 'votes'}. There is no winner yet.</p>}
      {candidates.map((c) => {
        const lead = c.votes === top && top > 0;
        return (
          <div key={c.id} className={`bar${lead ? ' leader' : ''}`}>
            <div className="bar-head"><span>{c.name}</span><span className="bar-num">{Math.round((c.votes / total) * 100)}% · {c.votes} {c.votes === 1 ? 'vote' : 'votes'}</span></div>
            <progress max={total} value={c.votes} aria-label={`${c.name}: ${c.votes} votes`} />
          </div>
        );
      })}
      {withdrawn.map((w) => <p key={w.id} className="muted small abstain-note">{w.name} withdrew: {w.votes} {w.votes === 1 ? 'vote' : 'votes'} void (not counted for any candidate, included in turnout)</p>)}
      {abstain && <p className="muted small abstain-note">Abstentions (not a candidate, never a winner): {abstain.votes} · included in turnout</p>}
    </div>
  );
}

/** Square photo thumbnail, or an initials box when there is no photo. */
export function Thumb({ url, name, size = 'md' }: { url: string | null; name: string; size?: 'sm' | 'md' | 'lg' }) {
  return url
    ? <img className={`thumb thumb-${size}`} src={url} alt={`Photo of ${name}`} />
    : <div className={`thumb thumb-${size} thumb-empty`} aria-hidden="true">{initials(name)}</div>;
}

export const initials = (n: string) => n.trim().split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase() || '?';

/**
 * Results of a campaign with several positions: one section per position (its own turnout, outcome and bars), optionally grouped by region.
 * Members who voted in at least one position are the campaign's turnout; each position also shows its own.
 */
export function PositionResults({ r }: { r: Pick<Results, 'positions' | 'turnout' | 'quorum' | 'group_by_region'> }) {
  return (
    <div className="results">
      <div className="results-turnout">
        <div className="field-label">Members who voted in at least one position</div>
        <TurnoutBar votes={r.turnout.votes} eligible={r.turnout.eligible} />
      </div>
      {r.quorum && <p className={r.quorum.met === false ? 'tie-note quorum-bad' : 'muted small'} role="status">{quorumLine(r.quorum)}</p>}
      {(r.positions ?? []).map((p) => <PositionResultBlock key={p.id} p={p} groupByRegion={!!r.group_by_region} />)}
    </div>
  );
}

const NO_REGION = 'No region';

function PositionResultBlock({ p, groupByRegion }: { p: PositionResult; groupByRegion: boolean }) {
  const all = p.candidates ?? [];
  const abstain = all.find((c) => c.is_abstain);
  const withdrawn = all.filter((c) => c.withdrawn && !c.is_abstain);
  const live = all.filter((c) => !c.is_abstain && !c.withdrawn);
  const total = Math.max(1, p.turnout.votes);
  const top = Math.max(0, ...live.map((c) => c.votes));
  const byRegion = new Map<string, typeof live>();
  for (const c of live) { const k = c.region ?? NO_REGION; byRegion.set(k, [...(byRegion.get(k) ?? []), c]); }
  const groups: [string, typeof live][] = groupByRegion
    ? [...byRegion].sort((a, b) => Number(a[0] === NO_REGION) - Number(b[0] === NO_REGION) || a[0].localeCompare(b[0]))
    : [['', live]];
  const bar = (c: (typeof live)[number]) => {
    const lead = c.votes === top && top > 0 && !p.tie;
    return (
      <div key={c.id} className={`bar${lead ? ' leader' : ''}`}>
        <div className="bar-head"><span>{c.name}{!groupByRegion && c.region ? <span className="muted small"> · {c.region}</span> : null}</span><span className="bar-num">{Math.round((c.votes / total) * 100)}% · {c.votes} {c.votes === 1 ? 'vote' : 'votes'}</span></div>
        <progress max={total} value={c.votes} aria-label={`${c.name}: ${c.votes} votes`} />
      </div>
    );
  };
  return (
    <section className="position-result" aria-label={p.title}>
      <h3>{p.title}</h3>
      <p className="muted small">{p.turnout.votes} {p.turnout.votes === 1 ? 'member voted' : 'members voted'} in this position</p>
      {p.candidates === null ? null : (
        <>
          {p.tie ? <p className="tie-note" role="status"><strong>Tie for first place:</strong> {p.tie.names.join(' and ')} each have {p.tie.votes} {p.tie.votes === 1 ? 'vote' : 'votes'}. There is no winner yet.</p>
            : p.winners && p.winners.length > 0 ? <p className="winner-line"><strong>{p.winners.length > 1 ? 'Winners' : 'Winner'}:</strong> {p.winners.map((w) => w.name).join(', ')}</p>
              : <p className="muted small">No winner (no votes).</p>}
          {groups.map(([region, list]) => (
            <div key={region || 'all'} className="region-group">
              {groupByRegion && <h4 className="region-heading">{region}</h4>}
              {list.map(bar)}
            </div>
          ))}
          {withdrawn.map((w) => <p key={w.id} className="muted small abstain-note">{w.name} withdrew: {w.votes} {w.votes === 1 ? 'vote' : 'votes'} void</p>)}
          {abstain && <p className="muted small abstain-note">Abstentions (not a candidate, never a winner): {abstain.votes}</p>}
        </>
      )}
    </section>
  );
}
