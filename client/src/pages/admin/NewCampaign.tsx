import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fromLocalInput, type Campaign } from '../../api';
import { BackLink, ErrorBox, PageTitle, SectionTitle } from '../../ui';

/** Step 1: details + voting window. Candidates and eligibility are added on the next screen (the draft needs an id first). */
export function NewCampaign() {
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [opens, setOpens] = useState('');
  const [closes, setCloses] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const c = await api<Campaign>('POST', '/api/campaigns', {
        title, description: description || null, opens_at: fromLocalInput(opens), closes_at: fromLocalInput(closes),
      });
      nav(`/admin/c/${c.id}/edit`);
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }

  return (
    <>
      <BackLink to="/admin">Back to campaigns</BackLink>
      <PageTitle title="Create campaign" />
      <form onSubmit={(e) => void submit(e)} className="card form-card">
        <section className="form-section">
          <SectionTitle icon="info">Campaign details</SectionTitle>
          <div className="stack">
            <label>Title<span className="field-helper">Shown to voters, e.g. “Election of the Commissioner”.</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} /></label>
            <label>Description <span className="field-helper">Optional. A short explanation for voters.</span>
              <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} rows={4} /></label>
          </div>
        </section>
        <section className="form-section">
          <SectionTitle icon="calendar">Voting window</SectionTitle>
          <div className="field-grid">
            <label>Opens at <span className="field-helper">Optional. Leave empty to open as soon as you start.</span>
              <input type="datetime-local" value={opens} onChange={(e) => setOpens(e.target.value)} /></label>
            <label>Closes at <span className="field-helper">Optional. Closes automatically at this time.</span>
              <input type="datetime-local" value={closes} onChange={(e) => setCloses(e.target.value)} /></label>
          </div>
        </section>
        <p className="muted small form-note">Next you will add candidates and choose who can vote.</p>
        <ErrorBox message={error} />
        <div className="form-actions">
          <Link className="btn btn-secondary" to="/admin">Cancel</Link>
          <button className="btn btn-primary" disabled={busy || !title.trim()}>Create draft</button>
        </div>
      </form>
    </>
  );
}
