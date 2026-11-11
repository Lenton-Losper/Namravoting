import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
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
            {t.label}{t.count !== undefined && <span className="tab-count">{t.count}</span>}
          </button>
        ))}
      </div>
      <div id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-${value}`} className={flush ? '' : 'tabpanel'}>{children}</div>
    </>
  );
}

/** Accessible modal / bottom sheet. Closes on Escape and backdrop click. */
export function Dialog(props: {
  title: string; children: ReactNode; confirmLabel: string; cancelLabel?: string; busy?: boolean; danger?: boolean;
  hideConfirm?: boolean; confirmDisabled?: boolean; className?: string; onConfirm: () => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { onCancel } = props;
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="backdrop" onClick={props.onCancel}>
      <div className={`sheet${props.className ? ` ${props.className}` : ''}`} role="dialog" aria-modal="true" aria-label={props.title} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <h2>{props.title}</h2>
        <div className="sheet-body">{props.children}</div>
        <div className="row">
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

/** Who reset the votes, when and why. Counts only, never voter data. Shown to everyone who can see the results. */
export function ResetHistory({ resets }: { resets: { at: string; by: string | null; reason: string; votes_cleared: number; candidates?: { name: string; votes: number }[] }[] | undefined }) {
  if (!resets?.length) return null;
  return (
    <section className="reset-history" aria-label="Reset history">
      <h3>Reset history</h3>
      <ul className="list">
        {resets.map((x, i) => (
          <li key={i} className="reset-item">
            <div><strong>{new Date(x.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</strong>{x.by ? ` · ${x.by}` : ''} · {x.votes_cleared} {x.votes_cleared === 1 ? 'vote' : 'votes'} cleared</div>
            <div className="muted small">Reason: {x.reason}</div>
            {x.candidates && x.candidates.length > 0 && <div className="muted small">Before the reset: {x.candidates.map((c) => `${c.name} ${c.votes}`).join(' · ')}</div>}
          </li>
        ))}
      </ul>
    </section>
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
export function ResultsChart({ candidates, turnout }: {
  candidates: { id: string; name: string; votes: number }[]; turnout: { votes: number; eligible: number | null };
}) {
  const total = Math.max(1, turnout.votes);
  const top = Math.max(0, ...candidates.map((c) => c.votes));
  return (
    <div className="results">
      <div className="results-turnout">
        <div className="field-label">Turnout</div>
        <TurnoutBar votes={turnout.votes} eligible={turnout.eligible} />
      </div>
      {candidates.map((c) => {
        const lead = c.votes === top && top > 0;
        return (
          <div key={c.id} className={`bar${lead ? ' leader' : ''}`}>
            <div className="bar-head"><span>{c.name}</span><span className="bar-num">{Math.round((c.votes / total) * 100)}% · {c.votes} {c.votes === 1 ? 'vote' : 'votes'}</span></div>
            <progress max={total} value={c.votes} aria-label={`${c.name}: ${c.votes} votes`} />
          </div>
        );
      })}
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
