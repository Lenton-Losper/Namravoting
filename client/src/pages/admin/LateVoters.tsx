import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, fmtDate, type CampaignDetail } from '../../api';
import { ErrorBox, SectionTitle } from '../../ui';

interface Late { enabled: boolean; applicable: boolean; mode: 'all' | 'list' | 'umoja'; entries: { at: string; by: string | null; identifier: string; reason: string }[] }

/**
 * Someone hired or reinstated after voting started is not on the frozen voter list. The creator can add one person to a running vote, with a
 * reason; it is recorded and shown in the exports. Leavers keep their vote. Not for votes open to all staff (nothing to add).
 */
export function LateVoters({ c, reload }: { c: CampaignDetail; reload: () => Promise<void> }) {
  const owner = c.my_role !== 'co_admin';
  const [d, setD] = useState<Late | null>(null);
  const [who, setWho] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const load = useCallback(() => { api<Late>('GET', `/api/campaigns/${c.id}/late-voters`).then(setD).catch(() => undefined); }, [c.id]);
  useEffect(load, [load]);

  async function add(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null); setDone(null);
    try {
      const r = await api<{ email?: string; employee_code?: string }>('POST', `/api/campaigns/${c.id}/late-voters`, { ...(c.eligibility === 'list' ? { email: who.trim() } : { employee_code: who.trim() }), reason: why.trim() });
      setDone(`${r.email ?? r.employee_code} can now vote.`); setWho(''); setWhy(''); load(); await reload();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  if (!d || !d.applicable || (c.status !== 'open' && d.entries.length === 0)) return null;
  return (
    <section className="late-voters">
      <SectionTitle icon="users">Voters added after voting started</SectionTitle>
      {d.entries.length === 0 ? <p className="muted small">None.</p> : (
        <ul className="list small">
          {d.entries.map((x, i) => <li key={i}><strong>{x.identifier}</strong> · {fmtDate(x.at)}{x.by ? ` · by ${x.by}` : ''} <span className="muted">Reason: {x.reason}</span></li>)}
        </ul>
      )}
      {c.status === 'open' && owner && d.enabled && (
        <form onSubmit={(e) => void add(e)} className="stack">
          <p className="field-helper">The voter list was frozen when voting started. Add one person who joined or was reinstated since, with a reason: it is recorded and shown in the exports. People who leave keep their vote.</p>
          <label>{c.eligibility === 'list' ? 'Email address' : 'Employee code'}
            <input value={who} onChange={(e) => setWho(e.target.value)} required maxLength={254} autoComplete="off" /></label>
          <label>Reason<span className="field-helper">At least 10 characters.</span>
            <textarea value={why} onChange={(e) => setWhy(e.target.value)} rows={2} maxLength={1000} required /></label>
          <div className="form-actions"><button className="btn btn-secondary" disabled={busy || !who.trim() || why.trim().length < 10}>Add late voter</button></div>
        </form>
      )}
      {c.status === 'open' && owner && !d.enabled && <p className="field-helper">Adding voters to a running vote is switched off for this system.</p>}
      {done && <p className="ok" role="status">{done}</p>}
      <ErrorBox message={error} />
    </section>
  );
}
