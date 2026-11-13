import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api, fromLocalInput, toLocalInput, type Candidate, type CampaignDetail } from '../../api';
import { EligibilityPicker, parseEmails, type EligMode } from '../../eligibility';
import { BackLink, ErrorBox, PageTitle, SectionTitle, Spinner, Thumb } from '../../ui';

/** `live` = the campaign is already open and was created with "Allow edits after start": only some things can still change. */
function DetailsSection({ c, live, onSaved }: { c: CampaignDetail; live: boolean; onSaved: () => void }) {
  const [title, setTitle] = useState(c.title);
  const [description, setDescription] = useState(c.description ?? '');
  const [opens, setOpens] = useState(toLocalInput(c.opens_at));
  const [closes, setCloses] = useState(toLocalInput(c.closes_at));
  const [allowEdits, setAllowEdits] = useState(!!c.allow_edits_after_start);
  const [allowAbstain, setAllowAbstain] = useState(!!c.allow_abstain);
  const [quorum, setQuorum] = useState(c.quorum_percent ? String(c.quorum_percent) : '');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault(); setError(null); setMsg(null);
    try {
      // Live: the opening time and the setting itself are locked, so they are not sent at all.
      const body = live
        ? { title, description: description || null, closes_at: fromLocalInput(closes) }
        : { title, description: description || null, opens_at: fromLocalInput(opens), closes_at: fromLocalInput(closes), allow_edits_after_start: allowEdits, allow_abstain: allowAbstain, quorum_percent: quorum ? Number(quorum) : null };
      await api('PATCH', `/api/campaigns/${c.id}`, body);
      setMsg(live ? 'Saved. Recorded as “Edited after start”.' : 'Saved.'); onSaved();
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
        <label>Opens at<span className="field-helper">{live ? 'Locked: voting has started.' : 'Optional. Windhoek time (CAT).'}</span><input type="datetime-local" value={opens} onChange={(e) => setOpens(e.target.value)} disabled={live} /></label>
        <label>Closes at<span className="field-helper">Optional. Windhoek time (CAT). Closes automatically.</span><input type="datetime-local" value={closes} onChange={(e) => setCloses(e.target.value)} /></label>
      </div>
      {!live && (
        <>
          <label>Quorum (optional)<span className="field-helper">{c.eligibility === 'all' ? 'Needs a known list of voters.' : 'Minimum turnout as a percentage of the eligible voters. A result below it is flagged. Locked once voting starts.'}</span>
            <input type="number" min={1} max={100} step={1} value={quorum} onChange={(e) => setQuorum(e.target.value)} disabled={c.eligibility === 'all'} /></label>
          <label className="check"><input type="checkbox" checked={allowAbstain} onChange={(e) => setAllowAbstain(e.target.checked)} /> Add an “Abstain (none of the above)” option</label>
          <p className="field-helper">Counts as a vote cast but can never win; reported separately. Locked once voting starts.</p>
          <label className="check"><input type="checkbox" checked={allowEdits} onChange={(e) => setAllowEdits(e.target.checked)} /> Allow edits after start</label>
          <p className="field-helper">When on, the title, description and closing time stay editable while voting is open, and candidates until the first vote is cast. Each edit is recorded and shown as “Edited after start”. Who can vote is always locked at start.</p>
        </>
      )}
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

function CandidatesSection({ c, live, onChanged }: { c: CampaignDetail; live: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState<Candidate | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locked = live && c.turnout > 0;   // after the first vote the candidates are fixed
  async function remove(x: Candidate) {
    setError(null);
    try { await api('DELETE', `/api/campaigns/${c.id}/candidates/${x.id}`); onChanged(); } catch (e) { setError((e as Error).message); }
  }
  const done = () => { setEditing(null); onChanged(); };
  return (
    <section className="form-section">
      <SectionTitle icon="users" actions={editing || locked ? undefined : <button className="btn btn-secondary btn-sm" onClick={() => setEditing('new')}>+ Add candidate</button>}>
        Candidates <span className="muted count">({c.candidates.length})</span>
      </SectionTitle>
      {locked
        ? <p className="field-helper" role="note">Locked: the first vote has been cast, so candidates can no longer change.</p>
        : <p className="field-helper">{live ? 'Voting is open. You can change candidates until the first vote is cast; each change is recorded and shown to voters as “Edited after start”.' : 'At least 2 candidates are needed to start voting.'}</p>}
      <ErrorBox message={error} />
      <ul className="cand-list">
        {c.candidates.map((x) => (
          <li key={x.id} className="cand-row">
            <Thumb url={x.photo_url} name={x.name} />
            <div className="grow"><strong>{x.name}</strong>{x.bio && <div className="muted small excerpt">{x.bio}</div>}</div>
            {!locked && (
              <div className="cand-actions">
                <button className="btn-text" onClick={() => setEditing(x)} aria-label={`Edit ${x.name}`}>Edit</button>
                <button className="btn-text btn-text-danger" onClick={() => void remove(x)} aria-label={`Remove ${x.name}`}>Remove</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {editing && !locked && <CandidateEditor key={editing === 'new' ? 'new' : editing.id} campaignId={c.id} existing={editing === 'new' ? undefined : editing} onDone={done} onCancel={() => setEditing(null)} />}
    </section>
  );
}

const modeLabel = (c: CampaignDetail) => c.eligibility === 'all' ? 'All signed-in NamRA staff' : c.eligibility === 'umoja' ? 'Umoja members only' : `Only the ${c.eligible_emails.length} listed email address${c.eligible_emails.length === 1 ? '' : 'es'}`;

/**
 * "Umoja" and "All staff" are saved the moment you pick them. (They used to be saved only by a separate button, and leaving the page
 * with "Done" silently kept the old mode.) The email list needs an explicit save, and "Done" waits until it has been saved.
 */
function EligibilitySection({ c, live, onSaved, onDirty }: { c: CampaignDetail; live: boolean; onSaved: () => void; onDirty: (d: boolean) => void }) {
  const [mode, setMode] = useState<EligMode>(c.eligibility);
  const [text, setText] = useState(c.eligible_emails.join('\n'));
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const emails = parseEmails(text);
  const savedList = [...c.eligible_emails].sort().join('|');
  const dirty = !live && mode === 'list' && (c.eligibility !== 'list' || [...emails].sort().join('|') !== savedList);
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);

  async function save(m: EligMode) {
    setError(null); setMsg(null);
    try {
      await api('PUT', `/api/campaigns/${c.id}/eligible`, m === 'list' ? { mode: m, emails } : { mode: m });
      setMsg('Saved.'); onSaved();
    } catch (e) { setError((e as Error).message); setMode(c.eligibility); }
  }
  function choose(m: EligMode) { setMode(m); if (m !== 'list') void save(m); }

  if (live) {
    return (
      <section className="form-section">
        <SectionTitle icon="lock">Eligibility</SectionTitle>
        <p>{modeLabel(c)}</p>
        <p className="field-helper">Locked: who can vote was frozen when voting started.</p>
      </section>
    );
  }
  return (
    <section className="form-section">
      <SectionTitle icon="lock">Eligibility</SectionTitle>
      <div className="stack">
        <EligibilityPicker mode={mode} onMode={choose} text={text} onText={setText} umojaCount={c.umoja_active_count} />
        <ErrorBox message={error} />
        {mode === 'list' && (
          <div className="form-actions">
            <button className="btn btn-secondary" onClick={() => void save('list')} disabled={emails.length === 0 || !dirty}>Save eligibility</button>
            {dirty && <span className="field-helper" role="status">Not saved yet.</span>}
          </div>
        )}
        {msg && !dirty && <span className="ok">{msg}</span>}
      </div>
    </section>
  );
}

/** Edit a draft: one bordered card with sections. An open campaign with "Allow edits after start" can also be edited here, within limits. */
export function EditCampaign() {
  const { id = '' } = useParams();
  const [c, setC] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [eligDirty, setEligDirty] = useState(false);
  const reload = useCallback(async () => {
    try { setC(await api<CampaignDetail>('GET', `/api/campaigns/${id}`)); setError(null); } catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { void reload(); }, [reload]);

  if (error && !c) return <><ErrorBox message={error === 'Not found' ? 'Campaign not found.' : error} onRetry={error === 'Not found' ? undefined : () => void reload()} /><Link to="/admin">Back to campaigns</Link></>;
  if (!c) return <Spinner />;
  const live = c.status === 'open' && !!c.allow_edits_after_start;
  if (c.status !== 'draft' && !live) return <Navigate to={`/admin/c/${c.id}`} replace />;
  return (
    <>
      <BackLink to={`/admin/c/${c.id}`}>Back to campaign</BackLink>
      <PageTitle title="Edit campaign">
        {eligDirty ? <button className="btn btn-primary" disabled title="Save the email list first">Done</button> : <Link className="btn btn-primary" to={`/admin/c/${c.id}`}>Done</Link>}
      </PageTitle>
      {live && <p className="admin-banner" role="status">Voting is open. Edits made here are recorded in the audit log and shown to voters as “Edited after start”.</p>}
      <div className="card form-card">
        <DetailsSection c={c} live={live} onSaved={() => void reload()} />
        {c.positions
          ? <section className="form-section"><SectionTitle icon="users">Positions and candidates</SectionTitle><p className="field-helper">Positions, nominations and candidates are managed on the campaign page, one position at a time.</p><Link className="btn btn-secondary btn-sm" to={`/admin/c/${c.id}`}>Manage positions</Link></section>
          : <CandidatesSection c={c} live={live} onChanged={() => void reload()} />}
        <EligibilitySection c={c} live={live} onSaved={() => void reload()} onDirty={setEligDirty} />
      </div>
    </>
  );
}
