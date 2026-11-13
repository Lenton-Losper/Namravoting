import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, fmtDate, type Notice, type SealCheck, type Tie } from '../api';
import { BackLink, ErrorBox, NoticeList, ResultsChart, SectionTitle, Spinner, StatusBadge, TurnoutBar } from '../ui';

/** Observers: a read-only view. Turnout, the sealed result once closed, the integrity check, the team, approvals and the audit trail. */
interface ObsItem { id: string; title: string; status: 'draft' | 'open' | 'closed'; owner: string; turnout: number; closes_at: string | null; results_published: boolean; archived_at: string | null }
interface ObsView {
  id: string; title: string; description: string | null; status: 'draft' | 'open' | 'closed'; eligibility: string; owner: string; opens_at: string | null; closes_at: string | null;
  results_published: boolean; archived: boolean; require_approval: boolean; turnout: { votes: number; eligible: number | null };
  result: { candidates: { id: string; name: string; votes: number; is_abstain?: boolean }[]; turnout: { votes: number; eligible: number | null }; tie: Tie | null } | null;
  seal: SealCheck | null; notices: Notice[]; team: { name: string; role: string }[];
  approvals: { kind: string; status: string; reason: string | null; requested_at: string; requested_by: string; decided_by: string | null; decided_at: string | null; executed_at: string | null }[];
  audit: { seq: number; at: string; action: string; actor: string | null; hash: string; details: Record<string, unknown> | null }[];
}
const ROLE = { co_admin: 'Co-admin', observer: 'Observer' } as Record<string, string>;
const ELIG = { all: 'All staff', umoja: 'Umoja members only', list: 'Specific email list' } as Record<string, string>;

export function ObserveList() {
  const [items, setItems] = useState<ObsItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { setError(null); api<{ campaigns: ObsItem[] }>('GET', '/api/observe').then((r) => setItems(r.campaigns)).catch((e: Error) => setError(e.message)); }, []);
  useEffect(load, [load]);
  return (
    <>
      <h1>Observing</h1>
      <p className="muted">Campaigns you were asked to watch. You can see turnout, the sealed result once voting has closed, and the audit trail. You cannot see counts while voting is open.</p>
      <ErrorBox message={error} onRetry={load} />
      {!items && !error && <Spinner />}
      {items?.length === 0 && <p className="muted">You are not observing any campaign.</p>}
      <ul className="list">
        {items?.map((c) => (
          <li key={c.id} className="card card-pad">
            <Link to={`/observe/${c.id}`}><strong>{c.title}</strong></Link> <StatusBadge status={c.status} />
            <div className="muted small">Run by {c.owner} · {c.turnout} {c.turnout === 1 ? 'vote' : 'votes'} cast{c.closes_at ? ` · closes ${fmtDate(c.closes_at)}` : ''}</div>
          </li>
        ))}
      </ul>
    </>
  );
}

export function ObserveCampaign() {
  const { id = '' } = useParams();
  const [v, setV] = useState<ObsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => { setError(null); api<ObsView>('GET', `/api/observe/${id}`).then(setV).catch((e: Error) => setError(e.message)); }, [id]);
  useEffect(load, [load]);
  if (error && !v) return <><ErrorBox message={error === 'Not found' ? 'You are not observing this campaign.' : error} onRetry={error === 'Not found' ? undefined : load} /><Link to="/observe">Back</Link></>;
  if (!v) return <Spinner />;
  const good = !!v.seal && v.seal.chain_ok && v.seal.sealed && v.seal.tallies_match !== false && v.seal.receipts_match !== false;
  return (
    <>
      <BackLink to="/observe">Back to Observing</BackLink>
      <section className="card card-accent head-card">
        <h1 className="head-title">{v.title}</h1>
        {v.description && <p className="head-desc">{v.description}</p>}
        <p className="meta"><StatusBadge status={v.status} /> Run by {v.owner} · Who can vote: {ELIG[v.eligibility] ?? v.eligibility} · Opens {fmtDate(v.opens_at)} · Closes {fmtDate(v.closes_at)}</p>
        {v.require_approval && <p className="muted small">Resets and permanent deletes of this campaign need a co-admin&rsquo;s approval.</p>}
      </section>

      <section className="card card-pad">
        <SectionTitle icon="chart">{v.status === 'closed' ? 'Sealed result' : 'Turnout'}</SectionTitle>
        <div className="results-turnout"><div className="field-label">Turnout</div><TurnoutBar votes={v.turnout.votes} eligible={v.turnout.eligible} /></div>
        {v.status !== 'closed' && <p className="muted">Per-candidate results are hidden until voting closes, for everyone. This protects the secrecy of every vote.</p>}
        {v.result && <ResultsChart candidates={v.result.candidates} turnout={v.result.turnout} tie={v.result.tie} />}
        {v.status === 'closed' && <p><a className="btn btn-secondary btn-sm" href={`/api/observe/${v.id}/audit-bundle.zip`} download>Download the audit bundle (.zip)</a></p>}
        {v.seal && (
          <div className="seal-panel" role="status">
            <p className={good ? 'ok' : 'bad'}>{good ? 'Verified: the result is sealed in the audit chain and nothing has changed since.' : 'NOT verified: the audit chain, the seal or the counters do not match.'}</p>
            {v.seal.seal_hash && <p className="muted small">Seal fingerprint: <code>{v.seal.seal_hash}</code></p>}
          </div>
        )}
      </section>

      <NoticeList notices={v.notices} />

      <section className="card card-pad">
        <SectionTitle icon="users">Team</SectionTitle>
        <ul className="list small"><li>{v.owner}: owner</li>{v.team.map((m, i) => <li key={i}>{m.name}: {ROLE[m.role] ?? m.role}</li>)}</ul>
        {v.approvals.length > 0 && (
          <>
            <h3>Approval requests</h3>
            <ul className="list small">
              {v.approvals.map((a, i) => (
                <li key={i}>{a.kind === 'reset' ? 'Reset' : 'Permanent delete'}: {a.status} · requested by {a.requested_by} {fmtDate(a.requested_at)}
                  {a.decided_by ? ` · decided by ${a.decided_by} ${fmtDate(a.decided_at)}` : ''}{a.reason ? ` · reason: ${a.reason}` : ''}</li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card card-pad">
        <SectionTitle icon="info">Audit trail</SectionTitle>
        <p className="muted small">Every entry is chained to the one before it. Entries about votes record that something happened, never who voted for whom.</p>
        <div className="table-wrap">
          <table className="audit-table">
            <thead><tr><th>#</th><th>When</th><th>Who</th><th>What</th></tr></thead>
            <tbody>
              {v.audit.map((a) => (
                <tr key={a.seq}><td>{a.seq}</td><td>{fmtDate(a.at)}</td><td>{a.actor ?? 'system'}</td>
                  <td><strong>{a.action}</strong>{a.details && Object.keys(a.details).length > 0 && <span className="muted small"> {JSON.stringify(a.details).slice(0, 240)}</span>}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
