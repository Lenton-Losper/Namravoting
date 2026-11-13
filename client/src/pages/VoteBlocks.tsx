import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, ApiError, fmtDate, type Notice, type Results } from '../api';
import { Icon } from '../icons';
import { closesIn } from '../time';
import { BackLink, Dialog, ErrorBox, NoticeBanner, NoticeList, PositionResults, Spinner, Thumb, initials } from '../ui';

/**
 * A campaign with positions (e.g. "Umoja Committee 2026": Press Secretary, Finance Officer ...).
 * The voter opens the campaign, taps a position block, votes in it, and the block is greyed out as done. Each position is its own vote,
 * in any order. A position that is done is never opened again (the server refuses its ballot too: 409).
 */

export interface BlockPosition { id: string; title: string; description: string | null; voted: boolean; candidateCount: number }
export interface BlocksInfo {
  title: string; description: string | null; opensAt: string | null; closesAt: string | null; resultsPublished: boolean;
  voterState: 'can_vote' | 'already_voted' | 'not_eligible' | 'not_member' | 'not_open' | 'closed';
  notices?: Notice[]; positions: BlockPosition[]; progress?: { voted: number; total: number };
}
interface BallotCandidate { id: string; name: string; bio: string | null; photoUrl: string | null; isAbstain: boolean; withdrawn: boolean; regionId: string | null; region: string | null }
interface Ballot {
  position: { id: string; title: string; description: string | null };
  regions: { id: string; name: string }[]; candidates: BallotCandidate[]; progress: { voted: number; total: number };
  campaign?: { title: string; closesAt: string | null };
}

function StateCard({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <section className="card card-pad state-card" aria-live="polite">
      <span className="state-icon"><Icon name={icon} size={22} /></span>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

const pendingKey = (token: string, pid: string) => `namra:pending-vote:${token}:${pid}`;
const clearPending = (token: string, pid: string) => { try { sessionStorage.removeItem(pendingKey(token, pid)); } catch { /* storage unavailable */ } };
const NO_REGION = 'No region';

/** Candidates grouped by region, in the campaign's region order; the Abstain line (no region) comes last, outside any group. */
export function groupByRegion(candidates: BallotCandidate[], regions: { id: string; name: string }[]): { key: string; name: string; items: BallotCandidate[] }[] {
  const order = new Map(regions.map((r, i) => [r.id, i]));
  const groups = new Map<string, { key: string; name: string; items: BallotCandidate[] }>();
  for (const c of candidates.filter((x) => !x.isAbstain)) {
    const key = c.regionId ?? 'none';
    if (!groups.has(key)) groups.set(key, { key, name: c.region ?? NO_REGION, items: [] });
    groups.get(key)!.items.push(c);
  }
  return [...groups.values()].sort((a, b) => (order.get(a.key) ?? 1e6) - (order.get(b.key) ?? 1e6));
}

/** One position's ballot: region filter, candidates grouped by region, one choice, then confirm. */
export function PositionBallot({ token, position, onBack, onVoted }: {
  token: string; position: { id: string; title: string }; onBack: () => void; onVoted: (title: string) => void;
}) {
  const [ballot, setBallot] = useState<Ballot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [region, setRegion] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const submitting = useRef(false);   // synchronous guard: a double tap can never send two requests
  const url = `/api/vote/${token}/positions/${position.id}`;

  const load = useCallback(async (): Promise<Ballot | 'gone' | null> => {
    try { const b = await api<Ballot>('GET', url); setBallot(b); setError(null); return b; }
    catch (e) {
      // Already voted here / closed / not open: this block is not available; go back to the list, which shows the true state.
      if (e instanceof ApiError && [403, 404, 409].includes(e.status)) return 'gone';
      setError((e as Error).message); return null;
    }
  }, [url]);
  useEffect(() => { void load().then((b) => { if (b === 'gone') onBack(); }); }, [load, onBack]);
  // Back from a re-sign-in with the choice kept: restore it (once). The person still presses Cast vote and confirms.
  useEffect(() => {
    let id: string | null = null;
    try { id = sessionStorage.getItem(pendingKey(token, position.id)); sessionStorage.removeItem(pendingKey(token, position.id)); } catch { /* storage unavailable */ }
    if (id) setSelected(id);
  }, [token, position.id]);

  const visible = useMemo(() => (ballot?.candidates ?? []).filter((c) => c.isAbstain || !region || c.regionId === region), [ballot, region]);
  const groups = useMemo(() => groupByRegion(visible, ballot?.regions ?? []), [visible, ballot]);
  const abstain = visible.find((c) => c.isAbstain);
  // A choice that the filter hides (or that no longer exists) is dropped, so nobody confirms a candidate they cannot see.
  useEffect(() => { if (selected && ballot && !visible.some((c) => c.id === selected)) setSelected(null); }, [visible, selected, ballot]);
  const chosen = ballot?.candidates.find((c) => c.id === selected);
  const count = (ballot?.candidates ?? []).filter((c) => !c.isAbstain).length;
  const shown = visible.filter((c) => !c.isAbstain).length;

  async function submit() {
    if (!selected || submitting.current) return;
    submitting.current = true; setBusy(true);
    try { sessionStorage.setItem(pendingKey(token, position.id), selected); } catch { /* storage unavailable */ }
    try {
      await api('POST', url, { candidateId: selected });
      clearPending(token, position.id); setSelected(null); setConfirming(false);
      onVoted(position.title);   // the chosen candidate's name is intentionally NOT kept on screen
    } catch (e) {
      setConfirming(false);
      if (e instanceof ApiError && e.status === 401) return;   // being signed back in; the ballot comes back with the choice selected
      clearPending(token, position.id);
      if (e instanceof ApiError && [403, 404, 409].includes(e.status)) { setSelected(null); onBack(); }   // definitive answer: show the true state
      else {
        // Network or server error: the outcome is unknown. Ask the server; if the vote landed this block is "already voted" (409).
        const fresh = await load();
        if (fresh === 'gone') { onVoted(position.title); }
        else if (!fresh) setUncertain(true);                                // could not even ask: do NOT invite a second attempt yet
        else setError('Your vote was not recorded. Please try again.');     // the server says there is no receipt, so voting again is safe
      }
    } finally { submitting.current = false; setBusy(false); }
  }
  async function recheck() {
    const fresh = await load();
    if (fresh === 'gone') { onVoted(position.title); return; }
    if (!fresh) return;
    setUncertain(false); setError('Your vote was not recorded. You can vote again.');
  }

  const card = (c: BallotCandidate) => (
    <button key={c.id} role="radio" aria-checked={selected === c.id} disabled={c.withdrawn}
      className={`candidate${selected === c.id ? ' selected' : ''}${c.isAbstain ? ' candidate-abstain' : ''}${c.withdrawn ? ' candidate-withdrawn' : ''}`} onClick={() => setSelected(c.id)}>
      {!c.isAbstain && <Thumb url={c.photoUrl} name={c.name} size="lg" />}
      <span className="candidate-text">
        <strong>{c.name}</strong>
        {c.region && !c.isAbstain && <span className="candidate-region">{c.region}</span>}
        {c.withdrawn && <span className="muted">Withdrawn: this candidate can no longer be chosen</span>}
        {c.bio && !c.withdrawn && <span className="muted">{c.bio}</span>}
      </span>
      <span className="candidate-check" aria-hidden="true"><Icon name="check" size={14} /></span>
    </button>
  );

  return (
    <>
      <button type="button" className="back-link back-button" onClick={onBack}>← All positions</button>
      <section className="card card-accent head-card">
        <div className="head-inner">
          <div className="initials-box" aria-hidden="true">{initials(position.title)}</div>
          <div className="grow">
            {ballot?.campaign?.title && <p className="meta ballot-campaign">{ballot.campaign.title}</p>}
            <h1 className="head-title">{position.title}</h1>
            {ballot?.position.description && <p className="head-desc">{ballot.position.description}</p>}
          </div>
        </div>
      </section>
      <ErrorBox message={error} />
      {!ballot && !error && !uncertain && <Spinner />}
      {uncertain && (
        <section className="card card-pad state-card" role="alert">
          <span className="state-icon"><Icon name="alert" size={22} /></span>
          <h2>Your vote may not have been recorded</h2>
          <p className="muted">The connection dropped before we heard back, and we could not reach the server to check. Please do not vote again until you have checked: press “Check again”.</p>
          <div className="form-actions"><button className="btn btn-primary" onClick={() => void recheck()}>Check again</button><button className="btn btn-secondary" onClick={onBack}>All positions</button></div>
        </section>
      )}
      {ballot && !uncertain && (
        <>
          <div className="region-filter">
            <label>Region
              <select value={region} onChange={(e) => setRegion(e.target.value)} aria-describedby="region-count">
                <option value="">All regions</option>
                {ballot.regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
            <p id="region-count" className="muted small" role="status">{region ? `Showing ${shown} of ${count} candidates` : `${count} candidate${count === 1 ? '' : 's'}`}</p>
          </div>
          <p className="field-label hint">Select one candidate</p>
          {shown === 0 && !abstain && <p className="muted">No candidates in this region. Choose “All regions” to see everyone.</p>}
          <div className="candidate-groups">
            {groups.map((g, i) => (
              <section key={g.key} aria-labelledby={`region-h-${i}`} className="candidate-group">
                <h2 id={`region-h-${i}`} className="region-heading">{g.name} <span className="muted count">({g.items.length})</span></h2>
                <div className="list radio-list" role="radiogroup" aria-labelledby={`region-h-${i}`}>{g.items.map(card)}</div>
              </section>
            ))}
            {abstain && <div className="list radio-list abstain-group" role="radiogroup" aria-label="Or abstain">{card(abstain)}</div>}
          </div>
          <div className="sticky-bar">
            <button className="btn btn-primary btn-block" disabled={!selected || busy} onClick={() => setConfirming(true)}>Cast vote</button>
          </div>
        </>
      )}
      {confirming && chosen && (
        <Dialog title={chosen.isAbstain ? `Abstain from ${position.title}?` : `Vote for ${chosen.name} as ${position.title}?`} confirmLabel="Confirm vote" cancelLabel="Go back" busy={busy}
          onConfirm={() => void submit()} onCancel={() => setConfirming(false)}>
          <p>This can't be changed.</p>
        </Dialog>
      )}
    </>
  );
}

/** The campaign page: header, progress, and a grid of position blocks. */
export function CampaignBlocks({ token, info, now, reload }: { token: string; info: BlocksInfo; now: Date; reload: () => Promise<unknown> }) {
  const [open, setOpen] = useState<{ id: string; title: string } | null>(null);
  const [justVoted, setJustVoted] = useState<string | null>(null);
  const [results, setResults] = useState<(Results & { title: string }) | null>(null);
  useEffect(() => {
    if (info.resultsPublished) void api<Results & { title: string }>('GET', `/api/vote/${token}/results`).then(setResults).catch(() => undefined);
  }, [info.resultsPublished, token]);

  const total = info.positions.length;
  const voted = info.positions.filter((p) => p.voted).length;
  const left = info.voterState === 'can_vote' ? closesIn(info.closesAt, now) : null;
  const back = useCallback(() => { setOpen(null); void reload(); }, [reload]);
  const done = useCallback((title: string) => { setOpen(null); setJustVoted(title); void reload(); }, [reload]);

  if (open && info.voterState === 'can_vote') return <PositionBallot token={token} position={open} onBack={back} onVoted={done} />;

  return (
    <>
      <BackLink to="/votes">Back to My votes</BackLink>
      <section className="card card-accent head-card">
        <div className="head-inner">
          <div className="initials-box" aria-hidden="true">{initials(info.title)}</div>
          <div className="grow">
            <h1 className="head-title">{info.title}</h1>
            {info.description && <p className="head-desc">{info.description}</p>}
            {info.closesAt && <p className="meta"><Icon name="clock" /> Closes {fmtDate(info.closesAt)}{left ? ` · ${left.replace('Closes in ', '')} left` : ''}</p>}
          </div>
        </div>
      </section>
      <NoticeBanner notices={info.notices} />
      {info.voterState === 'not_open' && <StateCard icon="clock" title="Voting has not opened yet"><p className="muted">{info.opensAt ? `Voting opens ${fmtDate(info.opensAt)}.` : 'Please check back soon.'}</p></StateCard>}
      {info.voterState === 'closed' && <StateCard icon="lock" title="Voting has closed"><p className="muted">{info.resultsPublished ? 'The results are below.' : 'The results have not been published yet.'}</p></StateCard>}
      {justVoted && info.voterState === 'can_vote' && <p className="vote-recorded" role="status"><Icon name="check" size={16} /> Your vote for {justVoted} was recorded. Your choice is secret and cannot be changed.</p>}

      {info.voterState === 'already_voted' && (
        <StateCard icon="check" title="You have voted in every position"><p className="muted">Thank you. Your choices are secret and cannot be changed.</p></StateCard>
      )}
      {(info.voterState === 'can_vote' || info.voterState === 'already_voted') && total > 0 && (
        <>
          <p className="vote-progress" role="status"><strong>{voted} of {total}</strong> position{total === 1 ? '' : 's'} voted</p>
          {info.voterState === 'can_vote' && <p className="muted small">Choose a position to vote in. You can vote in the positions in any order, and each vote is separate.</p>}
          <ul className="position-grid" aria-label="Positions">
            {info.positions.map((p) => (
              <li key={p.id}>
                <button type="button" className={`position-block${p.voted ? ' position-voted' : ''}`} disabled={p.voted || info.voterState !== 'can_vote'}
                  onClick={() => { setJustVoted(null); setOpen({ id: p.id, title: p.title }); }}
                  aria-label={p.voted ? `${p.title}: voted` : `${p.title}: ${p.candidateCount} candidates, not voted yet`}>
                  <span className="position-title">{p.title}</span>
                  {p.description && <span className="muted small excerpt">{p.description}</span>}
                  {p.voted
                    ? <span className="chip chip-closed position-status"><Icon name="check" size={14} /> Voted</span>
                    : <span className="chip chip-open position-status">{p.candidateCount} candidate{p.candidateCount === 1 ? '' : 's'}</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {info.resultsPublished && results && (
        <section className="card card-pad">
          <h2>Results</h2>
          {results.positions ? <PositionResults r={results} /> : null}
          {results.publication && <p className="muted small">Published by {results.publication.by ?? 'the campaign administrators'} on {fmtDate(results.publication.at)}{results.publication.scheduled ? ' (scheduled in advance; approved by the person who scheduled it)' : ''}.</p>}
          <NoticeList notices={results.notices} />
        </section>
      )}
    </>
  );
}
