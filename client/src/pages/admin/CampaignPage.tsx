import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDate, type CampaignDetail, type Results } from '../../api';
import { Icon } from '../../icons';
import { SharePanel } from '../../share';
import { BackLink, Dialog, ErrorBox, Field, ResultsChart, SectionTitle, Spinner, StatusBadge, Tabs, Thumb, initials } from '../../ui';

type Tab = 'candidates' | 'eligibility' | 'results';

function useResults(id: string, enabled: boolean, poll: boolean) {
  const [r, setR] = useState<Results | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const tick = () => api<Results>('GET', `/api/campaigns/${id}/results`).then((x) => { if (alive) { setR(x); setErr(null); } }).catch((e: Error) => alive && setErr(e.message));
    void tick();
    if (!poll) return () => { alive = false; };
    const t = setInterval(() => void tick(), 5000);   // live results: every 5 s
    return () => { alive = false; clearInterval(t); };
  }, [id, enabled, poll]);
  return { r, err };
}

function CandidatesTab({ c }: { c: CampaignDetail }) {
  return (
    <>
      <SectionTitle icon="users" actions={c.status === 'draft' ? <Link className="btn btn-secondary btn-sm" to={`/admin/c/${c.id}/edit`}>Edit candidates</Link> : undefined}>Candidates</SectionTitle>
      {c.candidates.length === 0
        ? <p className="muted">No candidates yet.</p>
        : (
          <ul className="cand-list">
            {c.candidates.map((x) => (
              <li key={x.id} className="cand-row">
                <Thumb url={x.photo_url} name={x.name} />
                <div className="grow"><strong>{x.name}</strong>{x.bio && <div className="muted small">{x.bio}</div>}</div>
              </li>
            ))}
          </ul>
        )}
    </>
  );
}

function EligibilityTab({ c }: { c: CampaignDetail }) {
  return (
    <>
      <SectionTitle icon="lock" actions={c.status === 'draft' ? <Link className="btn btn-secondary btn-sm" to={`/admin/c/${c.id}/edit`}>Edit eligibility</Link> : undefined}>Who can vote</SectionTitle>
      <div className="field-grid">
        <Field label="Eligible voters" helper="Who may take part in this vote">{c.eligibility === 'all' ? 'All signed-in NamRA staff' : c.eligibility === 'umoja' ? `Umoja members only (${c.umoja_active_count} active member${c.umoja_active_count === 1 ? '' : 's'})` : `${c.eligible_emails.length} listed email address${c.eligible_emails.length === 1 ? '' : 'es'}`}</Field>
        <Field label="Votes per person" helper="Enforced by the system">One</Field>
      </div>
      {c.eligibility === 'list' && (
        <Field label="Voter list">
          <ul className="email-list">{c.eligible_emails.map((e) => <li key={e}>{e}</li>)}</ul>
        </Field>
      )}
    </>
  );
}

function ResultsTab({ c, reload }: { c: CampaignDetail; reload: () => Promise<void> }) {
  const { r, err } = useResults(c.id, c.status !== 'draft', c.status === 'open');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // If the campaign auto-closed (closes_at passed) while we were watching, refresh the page state.
  useEffect(() => { if (c.status === 'open' && r?.status === 'closed') void reload(); }, [c.status, r?.status, reload]);

  async function publish() {
    setBusy(true);
    try { await api('POST', `/api/campaigns/${c.id}/publish`); await reload(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <>
      <SectionTitle icon="chart" actions={c.status === 'closed' ? (
        <>
          {c.results_published
            ? <span className="chip chip-open">Published to voters</span>
            : <button className="btn btn-primary btn-sm" onClick={() => void publish()} disabled={busy}>Publish results</button>}
          <a className="btn btn-secondary btn-sm" href={`/api/campaigns/${c.id}/results.csv`} download><Icon name="download" /> Export CSV</a>
        </>
      ) : undefined}>{c.status === 'open' ? 'Live results' : 'Results'}{c.status === 'open' && <span className="muted count"> · updates every 5 s</span>}</SectionTitle>
      <ErrorBox message={err ?? error} />
      {c.status === 'draft' && <p className="muted">Results will appear here once voting has started.</p>}
      {c.status !== 'draft' && (r ? <ResultsChart candidates={r.candidates} turnout={r.turnout} /> : !err && <Spinner />)}
    </>
  );
}

function SideCard({ c, reload }: { c: CampaignDetail; reload: () => Promise<void> }) {
  const [dialog, setDialog] = useState<'start' | 'close' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reason = c.candidates.length < 2 ? 'Add at least 2 candidates to start.'
    : c.eligibility === 'list' && c.eligible_emails.length === 0 ? 'Add at least one eligible email.' : null;

  async function act(kind: 'start' | 'close') {
    setBusy(true); setError(null);
    try { await api('POST', `/api/campaigns/${c.id}/${kind}`); setDialog(null); await reload(); }
    catch (e) { setError((e as Error).message); setDialog(null); } finally { setBusy(false); }
  }
  return (
    <aside className="card card-pad side-card">
      {c.status === 'draft' ? (
        <>
          <SectionTitle icon="flag">Actions</SectionTitle>
          <p className="field-helper">Starting opens the vote and locks the campaign. Details, candidates and voters can no longer be changed.</p>
          <div className="stack">
            <button className="btn btn-primary" disabled={!!reason} onClick={() => setDialog('start')}>Start voting</button>
            {reason && <p className="field-helper" role="note">{reason}</p>}
            <Link className="btn btn-secondary" to={`/admin/c/${c.id}/edit`}>Edit campaign</Link>
          </div>
        </>
      ) : (
        <>
          <SectionTitle icon="link">Share</SectionTitle>
          <SharePanel c={c} compact />
          {c.status === 'open' && <div className="stack side-close"><button className="btn btn-danger" onClick={() => setDialog('close')}>Close voting</button></div>}
        </>
      )}
      <ErrorBox message={error} />
      {dialog === 'start' && (
        <Dialog title="Start voting?" confirmLabel="Start and lock" busy={busy} onConfirm={() => void act('start')} onCancel={() => setDialog(null)}>
          <p>This <strong>locks the campaign</strong>. You will not be able to edit the details, candidates or eligible voters afterwards.</p>
        </Dialog>
      )}
      {dialog === 'close' && (
        <Dialog title="Close voting now?" confirmLabel="Close voting" danger busy={busy} onConfirm={() => void act('close')} onCancel={() => setDialog(null)}>
          <p>No more votes will be accepted. This cannot be undone.</p>
        </Dialog>
      )}
    </aside>
  );
}

export function CampaignPage() {
  const { id = '' } = useParams();
  const [c, setC] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('candidates');
  const reload = useCallback(async () => {
    try { setC(await api<CampaignDetail>('GET', `/api/campaigns/${id}`)); setError(null); } catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { void reload(); }, [reload]);

  if (error && !c) return <><ErrorBox message={error === 'Not found' ? 'Campaign not found.' : error} /><Link to="/admin">Back to campaigns</Link></>;
  if (!c) return <Spinner />;

  return (
    <>
      <BackLink to="/admin">Back to campaigns</BackLink>
      <section className="card card-accent head-card">
        <div className="head-inner">
          <div className="initials-box" aria-hidden="true">{initials(c.title)}</div>
          <div className="grow">
            <h1 className="head-title">{c.title}</h1>
            {c.description && <p className="head-desc">{c.description}</p>}
            <div className="meta-row">
              <span className="meta"><Icon name="flag" /> <StatusBadge status={c.status} /></span>
              <span className="meta"><Icon name="calendar" /> Opens {fmtDate(c.opens_at)}</span>
              <span className="meta"><Icon name="clock" /> Closes {fmtDate(c.closes_at)}</span>
            </div>
          </div>
          <div className="id-chip"><div className="field-label">Campaign ID</div><div className="id-value">{c.id.slice(0, 8).toUpperCase()}</div></div>
        </div>
      </section>

      <div className="cols">
        <div className="card card-pad main-col">
          <Tabs<Tab> label="Campaign sections" value={tab} onChange={setTab} tabs={[
            { id: 'candidates', label: 'Candidates', count: c.candidates.length },
            { id: 'eligibility', label: 'Eligibility' },
            { id: 'results', label: 'Results' },
          ]}>
            {tab === 'candidates' && <CandidatesTab c={c} />}
            {tab === 'eligibility' && <EligibilityTab c={c} />}
            {tab === 'results' && <ResultsTab c={c} reload={reload} />}
          </Tabs>
        </div>
        <SideCard c={c} reload={reload} />
      </div>
    </>
  );
}
