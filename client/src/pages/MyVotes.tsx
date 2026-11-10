import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate } from '../api';
import { Icon } from '../icons';
import { closesIn, useNow } from '../time';
import { ErrorBox, PageTitle, Spinner } from '../ui';

interface Item { shareToken: string; title: string; description: string | null; closesAt: string | null; opensAt: string | null; resultsPublished: boolean; voterState: string }

const label: Record<string, { text: string; cls: string }> = {
  can_vote: { text: 'Vote now', cls: 'chip-open' }, already_voted: { text: 'Voted', cls: 'chip-closed' },
  not_open: { text: 'Not open yet', cls: 'chip-draft' }, closed: { text: 'Closed', cls: 'chip-closed' },
};

export function MyVotes() {
  const now = useNow();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api<{ campaigns: Item[] }>('GET', '/api/vote').then((r) => setItems(r.campaigns)).catch((e: Error) => setError(e.message)); }, []);

  return (
    <>
      <PageTitle title="My votes" />
      <ErrorBox message={error} />
      {!items && !error && <Spinner />}
      {items && items.length === 0 && (
        <div className="card card-pad state-card"><Icon name="inbox" size={24} /><h2>Nothing to vote on right now</h2><p className="muted">When a vote you can take part in opens, it will appear here.</p></div>
      )}
      <ul className="list">
        {items?.map((c) => {
          const l = label[c.voterState] ?? label.closed;
          const left = c.voterState === 'can_vote' ? closesIn(c.closesAt, now) : null;
          return (
            <li key={c.shareToken}>
              <Link to={`/v/${c.shareToken}`} className="card card-pad vote-item">
                <div className="grow">
                  <strong className="vote-item-title">{c.title}</strong>
                  {c.description && <p className="muted small excerpt">{c.description}</p>}
                  <p className="meta"><Icon name="clock" /> {c.closesAt ? `${fmtDate(c.closesAt)}${left ? ` · ${left.replace('Closes in ', '')} left` : ''}` : 'No closing time'}</p>
                </div>
                <span className={`chip ${l.cls}`}>{c.voterState === 'closed' && c.resultsPublished ? 'Results' : l.text}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}
