import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, type Campaign } from '../../api';
import { Icon } from '../../icons';
import { ShareDialog } from '../../share';
import { ErrorBox, PageTitle, Spinner, StatusBadge, Tabs, TurnoutBar } from '../../ui';

type Tab = 'open' | 'draft' | 'closed' | 'archived';

function Stat({ icon, label, value }: { icon: string; label: string; value: number }) {
  return (
    <div className="card stat">
      <span className="orange-icon"><Icon name={icon} size={16} /></span>
      <div><div className="stat-label">{label}</div><div className="stat-num">{value}</div></div>
    </div>
  );
}

export function Dashboard() {
  const [items, setItems] = useState<Campaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('open');
  const [sharing, setSharing] = useState<Campaign | null>(null);
  const load = useCallback(() => { setError(null); api<{ campaigns: Campaign[] }>('GET', '/api/campaigns/mine').then((r) => setItems(r.campaigns)).catch((e: Error) => setError(e.message)); }, []);
  useEffect(load, [load]);

  const by = useMemo(() => ({
    open: items?.filter((c) => c.status === 'open') ?? [],
    draft: items?.filter((c) => c.status === 'draft') ?? [],
    closed: items?.filter((c) => c.status === 'closed' && !c.archived_at) ?? [],
    archived: items?.filter((c) => !!c.archived_at) ?? [],
  }), [items]);

  const empty: Record<Tab, string> = {
    open: 'No campaigns are open right now.', draft: 'No drafts. Create a campaign to get started.', closed: 'Closed campaigns will appear here.', archived: 'Archived campaigns will appear here.',
  };

  return (
    <>
      <PageTitle title="Campaigns"><Link className="btn btn-primary" to="/admin/new">Create campaign</Link></PageTitle>
      <ErrorBox message={error} onRetry={load} />
      {!items && !error && <Spinner />}
      {items && (
        <>
          <div className="stats">
            <Stat icon="flag" label="Active campaigns" value={by.open.length} />
            <Stat icon="edit" label="Drafts" value={by.draft.length} />
            <Stat icon="lock" label="Closed" value={by.closed.length} />
          </div>
          <Tabs<Tab> label="Campaign status" value={tab} onChange={setTab} flush tabs={[
            { id: 'open', label: 'Active', count: by.open.length },
            { id: 'draft', label: 'Drafts', count: by.draft.length },
            { id: 'closed', label: 'Closed', count: by.closed.length },
            { id: 'archived', label: 'Archived', count: by.archived.length },
          ]}>
            {by[tab].length === 0 ? (
              <div className="card card-pad center muted">{empty[tab]}</div>
            ) : (
              <div className="card table-wrap">
                <table className="table">
                  <thead><tr><th>Title</th><th>Status</th><th>Opens</th><th>Closes</th><th>Turnout</th><th><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    {by[tab].map((c) => (
                      <tr key={c.id}>
                        <td data-label="Title"><Link className="row-title" to={`/admin/c/${c.id}`}>{c.title}</Link></td>
                        <td data-label="Status"><StatusBadge status={c.status} /></td>
                        <td data-label="Opens">{fmtDate(c.opens_at)}</td>
                        <td data-label="Closes">{fmtDate(c.closes_at)}</td>
                        <td data-label="Turnout">{c.status === 'draft' ? '—' : <TurnoutBar votes={c.turnout ?? 0} eligible={c.eligible_count ?? null} />}</td>
                        <td data-label="">
                          <div className="row-actions">
                            <Link to={`/admin/c/${c.id}`}>View</Link>
                            {c.status === 'open' && <button className="btn btn-secondary btn-sm" onClick={() => setSharing(c)}><Icon name="share" /> Share</button>}
                            {c.status === 'draft' && (
                              <span title="Start the campaign to share it">
                                <button className="btn btn-secondary btn-sm" disabled aria-label="Share (start the campaign to share it)"><Icon name="share" /> Share</button>
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Tabs>
          {sharing && <ShareDialog c={sharing} onClose={() => setSharing(null)} />}
        </>
      )}
    </>
  );
}
