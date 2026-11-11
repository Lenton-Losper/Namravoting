import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api, fromLocalInput, toLocalInput, type Candidate, type CampaignDetail } from '../../api';
import { BackLink, ErrorBox, PageTitle, SectionTitle, Spinner, Thumb } from '../../ui';

const parseEmails = (raw: string) => [...new Set(raw.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];

function DetailsSection({ c, onSaved }: { c: CampaignDetail; onSaved: () => void }) {
  const [title, setTitle] = useState(c.title);
  const [description, setDescription] = useState(c.description ?? '');
  const [opens, setOpens] = useState(toLocalInput(c.opens_at));
  const [closes, setCloses] = useState(toLocalInput(c.closes_at));
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault(); setError(null); setMsg(null);
    try {
      await api('PATCH', `/api/campaigns/${c.id}`, { title, description: description || null, opens_at: fromLocalInput(opens), closes_at: fromLocalInput(closes) });
      setMsg('Saved.'); onSaved();
    } catch (err) { setError((err as Error).message); }
  }
  return (
    <form className="form-section" onSubmit={(e) => void save(e)}>
      <SectionTitle icon="info">Campaign details</SectionTitle>
      <div className="stack">
        <label>Title<span className="field-helper">Shown to voters.</span><input value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={200} /></label>
        <label>Description<span className="field-helper">Optional.</span><textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></label>
      </div>
      <SectionTitle icon="calendar">Voting window</SectionTitle>
      <div className="field-grid">
        <label>Opens at<span className="field-helper">Optional.</span><input type="datetime-local" value={opens} onChange={(e) => setOpens(e.target.value)} /></label>
        <label>Closes at<span className="field-helper">Optional. Closes automatically.</span><input type="datetime-local" value={closes} onChange={(e) => setCloses(e.target.value)} /></label>
      </div>
      <ErrorBox message={error} />
      <div className="form-actions"><button className="btn btn-secondary">Save details</button>{msg && <span className="ok">{msg}</span>}</div>
    </form>
  );
}

function CandidateEditor({ campaignId, existing, onDone, onCancel }: { campaignId: string; existing?: Candidate; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(existing?.name ?? '');
  const [bio, setBio] = useState(existing?.bio ?? '');
  const [file, setFile] = useState<File | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function pick(f: File | null) {
    setError(null);
    if (f && f.size > 2 * 1024 * 1024) { setError('Photo must be 2 MB or smaller.'); if (input.current) input.current.value = ''; return; }
    if (f && !['image/jpeg', 'image/png'].includes(f.type)) { setError('Photo must be a JPEG or PNG.'); if (input.current) input.current.value = ''; return; }
    setFile(f); setRemovePhoto(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    const fd = new FormData();
    fd.append('name', name); fd.append('bio', bio);
    if (file) fd.append('photo', file);
    if (existing && removePhoto) fd.append('removePhoto', 'true');
    try {
      await api(existing ? 'PATCH' : 'POST', `/api/campaigns/${campaignId}/candidates${existing ? `/${existing.id}` : ''}`, fd);
      onDone();
    } catch (err) { setError((err as Error).message); setBusy(false); }
  }

  const shown = preview ?? (removePhoto ? null : existing?.photo_url ?? null);
  return (
    <form className="inline-form stack" onSubmit={(e) => void submit(e)}>
      <h3>{existing ? 'Edit candidate' : 'Add candidate'}</h3>
      <div className="row-top">
        <Thumb url={shown} name={name || '?'} size="lg" />
        <div className="stack grow">
          <label>Photo<span className="field-helper">JPEG or PNG, max 2 MB.</span><input ref={input} type="file" accept="image/jpeg,image/png" onChange={(e) => pick(e.target.files?.[0] ?? null)} /></label>
          {existing?.photo_url && !file && (
            <label className="check"><input type="checkbox" checked={removePhoto} onChange={(e) => setRemovePhoto(e.target.checked)} /> Remove current photo</label>
          )}
        </div>
      </div>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></label>
      <label>Short bio <span className="field-helper">{bio.length}/500 characters</span><textarea rows={3} value={bio} onChange={(e) => setBio(e.target.value)} maxLength={500} /></label>
      <ErrorBox message={error} />
      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !name.trim()}>{existing ? 'Save candidate' : 'Add candidate'}</button>
      </div>
    </form>
  );
}

function CandidatesSection({ c, onChanged }: { c: CampaignDetail; onChanged: () => void }) {
  const [editing, setEditing] = useState<Candidate | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function remove(x: Candidate) {
    setError(null);
    try { await api('DELETE', `/api/campaigns/${c.id}/candidates/${x.id}`); onChanged(); } catch (e) { setError((e as Error).message); }
  }
  const done = () => { setEditing(null); onChanged(); };
  return (
    <section className="form-section">
      <SectionTitle icon="users" actions={editing ? undefined : <button className="btn btn-secondary btn-sm" onClick={() => setEditing('new')}>+ Add candidate</button>}>
        Candidates <span className="muted count">({c.candidates.length})</span>
      </SectionTitle>
      <p className="field-helper">At least 2 candidates are needed to start voting.</p>
      <ErrorBox message={error} />
      <ul className="cand-list">
        {c.candidates.map((x) => (
          <li key={x.id} className="cand-row">
            <Thumb url={x.photo_url} name={x.name} />
            <div className="grow"><strong>{x.name}</strong>{x.bio && <div className="muted small excerpt">{x.bio}</div>}</div>
            <div className="cand-actions">
              <button className="btn-text" onClick={() => setEditing(x)} aria-label={`Edit ${x.name}`}>Edit</button>
              <button className="btn-text btn-text-danger" onClick={() => void remove(x)} aria-label={`Remove ${x.name}`}>Remove</button>
            </div>
          </li>
        ))}
      </ul>
      {editing && <CandidateEditor key={editing === 'new' ? 'new' : editing.id} campaignId={c.id} existing={editing === 'new' ? undefined : editing} onDone={done} onCancel={() => setEditing(null)} />}
    </section>
  );
}

function EligibilitySection({ c, onSaved }: { c: CampaignDetail; onSaved: () => void }) {
  const [mode, setMode] = useState(c.eligibility);
  const [text, setText] = useState(c.eligible_emails.join('\n'));
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const emails = parseEmails(text);
  async function save() {
    setError(null); setMsg(null);
    try {
      await api('PUT', `/api/campaigns/${c.id}/eligible`, mode === 'list' ? { mode, emails } : { mode });
      setMsg('Saved.'); onSaved();
    } catch (e) { setError((e as Error).message); }
  }
  return (
    <section className="form-section">
      <SectionTitle icon="lock">Eligibility</SectionTitle>
      <div className="stack">
        <label className="check"><input type="radio" name="elig" checked={mode === 'umoja'} onChange={() => setMode('umoja')} /> Umoja members only ({c.umoja_active_count} active member{c.umoja_active_count === 1 ? '' : 's'})</label>
        <label className="check"><input type="radio" name="elig" checked={mode === 'all'} onChange={() => setMode('all')} /> All signed-in NamRA staff</label>
        <label className="check"><input type="radio" name="elig" checked={mode === 'list'} onChange={() => setMode('list')} /> Only these email addresses</label>
        {mode === 'list' && (
          <label>Email addresses<span className="field-helper">One per line, or separated by commas. {emails.length} address{emails.length === 1 ? '' : 'es'}.</span>
            <textarea rows={6} value={text} onChange={(e) => setText(e.target.value)} /></label>
        )}
        <ErrorBox message={error} />
        <div className="form-actions"><button className="btn btn-secondary" onClick={() => void save()} disabled={mode === 'list' && emails.length === 0}>Save eligibility</button>{msg && <span className="ok">{msg}</span>}</div>
      </div>
    </section>
  );
}

/** Edit a draft: one bordered card with sections (details, window, candidates, eligibility). */
export function EditCampaign() {
  const { id = '' } = useParams();
  const [c, setC] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try { setC(await api<CampaignDetail>('GET', `/api/campaigns/${id}`)); setError(null); } catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { void reload(); }, [reload]);

  if (error && !c) return <><ErrorBox message={error === 'Not found' ? 'Campaign not found.' : error} onRetry={error === 'Not found' ? undefined : () => void reload()} /><Link to="/admin">Back to campaigns</Link></>;
  if (!c) return <Spinner />;
  if (c.status !== 'draft') return <Navigate to={`/admin/c/${c.id}`} replace />;
  return (
    <>
      <BackLink to={`/admin/c/${c.id}`}>Back to campaign</BackLink>
      <PageTitle title="Edit campaign"><Link className="btn btn-primary" to={`/admin/c/${c.id}`}>Done</Link></PageTitle>
      <div className="card form-card">
        <DetailsSection c={c} onSaved={() => void reload()} />
        <CandidatesSection c={c} onChanged={() => void reload()} />
        <EligibilitySection c={c} onSaved={() => void reload()} />
      </div>
    </>
  );
}
