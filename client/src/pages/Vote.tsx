import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, fmtDate, type Notice, type Results } from '../api';
import { Icon } from '../icons';
import { closesIn, useNow } from '../time';
import { BackLink, Dialog, ErrorBox, NoticeBanner, NoticeList, ResultsChart, Spinner, Thumb, initials } from '../ui';

type VoterState = 'can_vote' | 'already_voted' | 'not_eligible' | 'not_member' | 'not_open' | 'closed';
interface Info {
  title: string; description: string | null; opensAt: string | null; closesAt: string | null; resultsPublished: boolean;
  voterState: VoterState; notices?: Notice[]; candidates: { id: string; name: string; bio: string | null; photoUrl: string | null; isAbstain?: boolean }[];
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

function PublishedResults({ token }: { token: string }) {
  const [r, setR] = useState<(Results & { title: string }) | null>(null);
  useEffect(() => { api<Results & { title: string }>('GET', `/api/vote/${token}/results`).then(setR).catch(() => undefined); }, [token]);
  if (!r) return null;
  return <section className="card card-pad"><h2>Results</h2>{r.candidates && <ResultsChart candidates={r.candidates} turnout={r.turnout} tie={r.tie} />}<NoticeList notices={r.notices} /></section>;
}

const pendingKey = (token: string) => `namra:pending-vote:${token}`;
const clearPending = (token: string) => { try { sessionStorage.removeItem(pendingKey(token)); } catch { /* storage unavailable */ } };

export function VotePage() {
  const { shareToken = '' } = useParams();
  const now = useNow();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [ineligible, setIneligible] = useState(false);
  const [notMember, setNotMember] = useState(false);
  const submitting = useRef(false);   // synchronous guard: a double tap can never send two requests

  const load = useCallback(async (): Promise<Info | null> => {
    try {
      const i = await api<Info>('GET', `/api/vote/${shareToken}`);
      setInfo(i); setError(null); setInvalid(false); setIneligible(false); setNotMember(false);
      return i;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setInvalid(true);                          // unknown or malformed link
      else if (e instanceof ApiError && e.status === 403 && e.code === 'not_eligible') setIneligible(true);
      else if (e instanceof ApiError && e.status === 403 && e.code === 'not_member') setNotMember(true);
      else setError((e as Error).message);
      return null;
    }
  }, [shareToken]);
  useEffect(() => { if (selected && info && !info.candidates.some((c) => c.id === selected)) setSelected(null); }, [info, selected]);   // a restored choice that no longer exists
  useEffect(() => { void load(); }, [load]);
  // Back from a re-sign-in with the choice kept: restore it (once). The person still presses Vote and confirms.
  useEffect(() => {
    let id: string | null = null;
    try { id = sessionStorage.getItem(pendingKey(shareToken)); sessionStorage.removeItem(pendingKey(shareToken)); } catch { /* storage unavailable */ }
    if (id) setSelected(id);
  }, [shareToken]);

  async function submit() {
    if (!selected || submitting.current) return;
    submitting.current = true; setBusy(true);
    // Kept only until the answer arrives. If the session turns out to have expired (401) it survives the trip through sign-in;
    // for every other outcome it is removed again below.
    try { sessionStorage.setItem(pendingKey(shareToken), selected); } catch { /* storage unavailable */ }
    try {
      await api('POST', `/api/vote/${shareToken}`, { candidateId: selected });
      clearPending(shareToken); setSelected(null); setConfirming(false); setDone(true);   // candidate name is intentionally NOT kept on screen
    } catch (e) {
      setConfirming(false);
      if (e instanceof ApiError && e.status === 401) return;   // being signed back in; the ballot comes back with the choice selected
      clearPending(shareToken);
      if (e instanceof ApiError && [403, 404, 409].includes(e.status)) {
        // Definitive answers (already voted / closed / not open / not eligible): show the matching state, not an error.
        setSelected(null); await load();
      } else {
        // Network or server error: the outcome is unknown. Re-sync from the server; if the vote did land we will see "already voted".
        const fresh = await load();
        if (!fresh || fresh.voterState === 'can_vote') setError("We couldn't confirm your vote. Check your connection and try again.");
      }
    } finally { submitting.current = false; setBusy(false); }
  }

  if (invalid) {
    return (
      <section className="card card-pad state-card" aria-live="polite">
        <span className="state-icon"><Icon name="alert" size={22} /></span>
        <h2>This voting link isn't valid</h2>
        <p className="muted">Check that you opened the full link or scanned the whole QR code.</p>
        <Link className="btn btn-secondary" to="/votes">Go to My votes</Link>
      </section>
    );
  }
  if (notMember) {
    return (
      <StateCard icon="ban" title="This vote is for Umoja members">
        <p className="muted">This vote is for Umoja members. You're not on the Umoja membership list. Sign up as an Umoja member to take part, or contact Human Capital if you think this is a mistake.</p>
        <Link className="btn btn-secondary" to="/votes">Go to My votes</Link>
      </StateCard>
    );
  }
  if (ineligible) {
    return <StateCard icon="ban" title="You are not eligible to vote here"><p className="muted">Your account is not on the voter list for this vote. Contact the organiser if you think this is a mistake.</p><Link className="btn btn-secondary" to="/votes">Go to My votes</Link></StateCard>;
  }
  if (error && !info) return <StateCard icon="alert" title="Can't open this vote"><p className="muted">{error}</p><button className="btn btn-secondary" onClick={() => void load()}>Try again</button></StateCard>;
  if (!info) return <Spinner />;

  const chosen = info.candidates.find((c) => c.id === selected);
  const left = info.voterState === 'can_vote' ? closesIn(info.closesAt, now) : null;

  return (
    <>
      <BackLink to="/votes">Back to My votes</BackLink>
      <section className="card card-accent head-card">
        <div className="head-inner">
          <div className="initials-box" aria-hidden="true">{initials(info.title)}</div>
          <div className="grow">
            <h1 className="head-title">{info.title}</h1>
            {info.description && <p className="head-desc">{info.description}</p>}
            {info.closesAt && (
              <p className="meta"><Icon name="clock" /> Closes {fmtDate(info.closesAt)}{left ? ` · ${left.replace('Closes in ', '')} left` : ''}</p>
            )}
          </div>
        </div>
      </section>
      <ErrorBox message={error} />
      <NoticeBanner notices={info.notices} />

      {done && <StateCard icon="check" title="Your vote has been recorded"><p className="muted">Thank you for voting. Your choice is secret and cannot be changed.</p></StateCard>}
      {!done && info.voterState === 'already_voted' && <StateCard icon="check" title="You have already voted"><p className="muted">Your vote was recorded. Each person can vote once.</p></StateCard>}
      {!done && info.voterState === 'not_open' && <StateCard icon="clock" title="Voting has not opened yet"><p className="muted">{info.opensAt ? `Voting opens ${fmtDate(info.opensAt)}.` : 'Please check back soon.'}</p></StateCard>}
      {!done && info.voterState === 'closed' && <StateCard icon="lock" title="Voting has closed"><p className="muted">{info.resultsPublished ? 'The results are below.' : 'The results have not been published yet.'}</p></StateCard>}

      {info.resultsPublished && <PublishedResults token={shareToken} />}

      {!done && info.voterState === 'can_vote' && (
        <>
          <p className="field-label hint">Select one candidate</p>
          <ul className="list" role="radiogroup" aria-label="Candidates">
            {info.candidates.map((c) => (
              <li key={c.id}>
                <button role="radio" aria-checked={selected === c.id} className={`candidate${selected === c.id ? ' selected' : ''}${c.isAbstain ? ' candidate-abstain' : ''}`} onClick={() => setSelected(c.id)}>
                  {!c.isAbstain && <Thumb url={c.photoUrl} name={c.name} size="lg" />}
                  <span className="candidate-text"><strong>{c.name}</strong>{c.bio && <span className="muted">{c.bio}</span>}</span>
                  <span className="candidate-check" aria-hidden="true"><Icon name="check" size={14} /></span>
                </button>
              </li>
            ))}
          </ul>
          <div className="sticky-bar">
            <button className="btn btn-primary btn-block" disabled={!selected || busy} onClick={() => setConfirming(true)}>Cast vote</button>
          </div>
        </>
      )}

      {confirming && chosen && (
        <Dialog title={chosen.isAbstain ? 'Abstain from this vote?' : `Vote for ${chosen.name}?`} confirmLabel="Confirm vote" cancelLabel="Go back" busy={busy}
          onConfirm={() => void submit()} onCancel={() => setConfirming(false)}>
          <p>This can't be changed.</p>
        </Dialog>
      )}
    </>
  );
}
