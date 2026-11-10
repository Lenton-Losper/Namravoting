import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, type Summary } from '../../api';
import { Icon } from '../../icons';
import { ErrorBox, PageTitle, Spinner, StatusBadge, Thumb, TurnoutBar } from '../../ui';

export function ResultsArchive() {
  const [s, setS] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<Summary>('GET', '/api/campaigns/summary').then(setS).catch((e: Error) => setError(e.message)); }, []);
  const closed = s ? [...s.closed].sort((a, b) => (b.closed_at ?? '').localeCompare(a.closed_at ?? '')) : [];

  return (
    <>
      <PageTitle title="Results" />
      <ErrorBox message={error} />
      {!s && !error && <Spinner />}
      {s && closed.length === 0 && <div className="card card-pad center muted">Closed campaigns will appear here.</div>}
      <div className="grid3">
        {closed.map((c) => (
          <article key={c.id} className="card card-pad result-card">
            <div className="card-top"><h2>{c.title}</h2><StatusBadge status="closed" /></div>
            <p className="meta"><Icon name="calendar" /> {fmtDate(c.opens_at ?? c.started_at)} – {fmtDate(c.closed_at)}</p>
            <div className="winner">
              <Thumb url={c.winner?.photo_url ?? null} name={c.winner?.name ?? '–'} />
              <div>
                <div className="field-label">{c.winner?.tie ? 'Tied lead' : 'Winner'}</div>
                <strong>{c.winner ? c.winner.name : 'No votes cast'}</strong>
              </div>
            </div>
            <div className="field-label">Turnout</div>
            <TurnoutBar votes={c.turnout} eligible={c.eligible_count} />
            <Link className="card-link" to={`/admin/c/${c.id}`}>View results →</Link>
          </article>
        ))}
      </div>
    </>
  );
}
