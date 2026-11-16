import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, fmtDate } from '../api';
import { Icon } from '../icons';
import { Dialog, ErrorBox, Spinner, Thumb } from '../ui';

/**
 * The candidate's own page, opened from the nomination link or QR code of one position. Signing in is required (the router sends a visitor
 * to Microsoft first and brings them back here). They fill in their profile and submit it; they can change it until the administrator
 * approves it, or until the campaign starts. Only approved candidates reach the ballot.
 */

type State = 'not_invited' | 'open' | 'closed' | 'expired' | 'ended';
interface Info {
  campaign: { title: string }; position: { id: string; title: string; description: string | null; ruleText?: string | null };
  state: State; closesAt: string | null; regions: { id: string; name: string }[]; defaultName: string; canEdit: boolean;
  profile: { id: string; name: string; bio: string | null; pledge?: string | null; regionId: string | null; status: 'invited' | 'submitted' | 'approved' | 'rejected' | 'withdrawn'; reviewReason: string | null; photoUrl: string | null } | null;
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

const STATUS_TEXT: Record<NonNullable<Info['profile']>['status'], { title: string; body: string }> = {
  invited: { title: 'Invited', body: 'Fill in your profile and submit it.' },
  submitted: { title: 'Submitted: waiting for the administrator', body: 'You can still change your profile until the administrator approves it.' },
  approved: { title: 'Approved: you are on the ballot', body: 'Your profile is approved and can no longer be changed. Ask the campaign administrator if something must be corrected.' },
  rejected: { title: 'Not approved', body: 'The administrator did not approve this profile. You can change it and submit it again.' },
  withdrawn: { title: 'You withdrew', body: 'You are not standing for this position. You can submit your profile again while nominations are open.' },
};

export function NominatePage() {
  const { token = '' } = useParams();
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [denied, setDenied] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [bio, setBio] = useState('');
  const [pledge, setPledge] = useState('');
  const [region, setRegion] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [removePhoto, setRemovePhoto] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const i = await api<Info>('GET', `/api/nominate/${token}`);
      setInfo(i); setError(null);
      setName(i.profile?.name ?? i.defaultName); setBio(i.profile?.bio ?? ''); setPledge(i.profile?.pledge ?? ''); setRegion(i.profile?.regionId ?? ''); setFile(null); setRemovePhoto(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setInvalid(true);
      else if (e instanceof ApiError && e.status === 403) setDenied(e.message);
      else setError((e as Error).message);
    }
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!file) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function pick(f: File | null) {
    setError(null);
    if (f && f.size > 2 * 1024 * 1024) { setError('Photo must be 2 MB or smaller.'); if (fileInput.current) fileInput.current.value = ''; return; }
    if (f && !['image/jpeg', 'image/png'].includes(f.type)) { setError('Photo must be a JPEG or PNG.'); if (fileInput.current) fileInput.current.value = ''; return; }
    setFile(f); setRemovePhoto(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null); setSaved(null);
    const fd = new FormData();
    fd.append('name', name); fd.append('bio', bio); fd.append('pledge', pledge); fd.append('region_id', region);
    if (file) fd.append('photo', file);
    if (removePhoto) fd.append('removePhoto', 'true');
    try {
      await api('PUT', `/api/nominate/${token}`, fd);
      setSaved(info?.profile ? 'Saved. The administrator will review your updated profile.' : 'Submitted. The administrator will review your profile.');
      await load();
    } catch (err) { setError((err as Error).message); if (err instanceof ApiError && err.status === 409) await load(); } finally { setBusy(false); }
  }
  async function withdraw() {
    setBusy(true); setError(null); setSaved(null);
    try { await api('POST', `/api/nominate/${token}/withdraw`); setConfirmWithdraw(false); setSaved('You have withdrawn your nomination.'); await load(); }
    catch (err) { setError((err as Error).message); setConfirmWithdraw(false); } finally { setBusy(false); }
  }

  if (invalid) {
    return <StateCard icon="alert" title="This nomination link isn't valid"><p className="muted">Check that you opened the full link or scanned the whole QR code, or ask the campaign administrator for a new one.</p><Link className="btn btn-secondary" to="/votes">Go to My votes</Link></StateCard>;
  }
  if (denied) {
    return <StateCard icon="ban" title="You can't nominate yourself here"><p className="muted">{denied}</p><Link className="btn btn-secondary" to="/votes">Go to My votes</Link></StateCard>;
  }
  if (error && !info) return <StateCard icon="alert" title="Can't open this page"><p className="muted">{error}</p><button className="btn btn-secondary" onClick={() => void load()}>Try again</button></StateCard>;
  if (!info) return <Spinner />;

  const p = info.profile;
  const closed: Partial<Record<State, string>> = {
    ended: 'Nominations closed when voting started.',
    expired: `Nominations closed on ${fmtDate(info.closesAt)}.`,
    closed: 'The administrator has closed nominations for this position.',
    not_invited: 'Nominations are not open for this position.',
  };
  const shown = preview ?? (removePhoto ? null : p?.photoUrl ?? null);

  return (
    <div className="nominate-page">
      <section className="card card-accent head-card">
        <div className="head-inner">
          <div className="grow">
            <p className="meta">{info.campaign.title}</p>
            <h1 className="head-title">Stand for {info.position.title}</h1>
            {info.position.description && <p className="head-desc">{info.position.description}</p>}
            {info.position.ruleText && <p className="rule-text"><Icon name="info" size={16} /> <span>{info.position.ruleText}</span></p>}
            {info.state === 'open' && info.closesAt && <p className="meta"><Icon name="clock" /> Nominations close {fmtDate(info.closesAt)}</p>}
          </div>
        </div>
      </section>

      {p && (
        <section className={`card card-pad nomination-status nomination-${p.status}`} role="status" aria-live="polite">
          <h2>{STATUS_TEXT[p.status].title}</h2>
          <p className="muted">{STATUS_TEXT[p.status].body}</p>
          {p.status === 'rejected' && p.reviewReason && <p><strong>Reason:</strong> {p.reviewReason}</p>}
        </section>
      )}
      {info.state !== 'open' && <StateCard icon="lock" title="Nominations are closed"><p className="muted">{closed[info.state]}</p></StateCard>}
      {saved && <p className="ok" role="status">{saved}</p>}
      <ErrorBox message={error} />

      {info.state === 'open' && info.canEdit && (
        <form className="card card-pad stack nominate-form" onSubmit={(e) => void submit(e)}>
          <h2>{p ? 'Your profile' : 'Create your profile'}</h2>
          <p className="field-helper">This is what voters will see on the ballot once the administrator approves it. Fields marked * are required.</p>
          {/* Each field: a short label, then its help text, linked with aria-describedby (the help is not part of the label's name). */}
          <div className="row-top">
            <Thumb url={shown} name={name || '?'} size="lg" />
            <div className="field-block grow">
              <label htmlFor="nom-photo">Photo</label>
              <p id="nom-photo-help" className="field-helper">A clear, recent head-and-shoulders photo. JPG or PNG, max 2 MB.</p>
              <input id="nom-photo" ref={fileInput} type="file" accept="image/jpeg,image/png" aria-describedby="nom-photo-help" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
              {p?.photoUrl && !file && <label className="check"><input type="checkbox" checked={removePhoto} onChange={(e) => setRemovePhoto(e.target.checked)} /> Remove current photo</label>}
            </div>
          </div>
          <div className="field-block">
            <label htmlFor="nom-name">Name *</label>
            <p id="nom-name-help" className="field-helper">Your full name as colleagues know you, e.g. Maria Shikongo</p>
            <input id="nom-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoComplete="name"
              placeholder="First name and surname" aria-describedby="nom-name-help" />
          </div>
          <div className="field-block">
            <label htmlFor="nom-region">Region *</label>
            <p id="nom-region-help" className="field-helper">The region where you're based.</p>
            <select id="nom-region" value={region} onChange={(e) => setRegion(e.target.value)} required aria-describedby="nom-region-help">
              <option value="" disabled>Choose your region…</option>
              {info.regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div className="field-block">
            <label htmlFor="nom-pledge">Pledge</label>
            <p id="nom-pledge-help" className="field-helper">One line voters see on the ballot, e.g. 'A stronger voice for every region'</p>
            <input id="nom-pledge" value={pledge} onChange={(e) => setPledge(e.target.value)} maxLength={160} aria-describedby="nom-pledge-help nom-pledge-count" />
            <p id="nom-pledge-count" className="field-helper char-count" aria-live="polite">{pledge.length}/160 characters</p>
          </div>
          <div className="field-block">
            <label htmlFor="nom-bio">Short bio</label>
            <p id="nom-bio-help" className="field-helper">2–4 sentences: your role, your experience, and what you'll do if elected. Max 500 characters.</p>
            <textarea id="nom-bio" rows={5} value={bio} onChange={(e) => setBio(e.target.value)} maxLength={500} aria-describedby="nom-bio-help nom-bio-count"
              placeholder="e.g. Taxation Officer in Domestic Taxes, 6 years at NamRA. I want to improve communication between regions and make sure every member's voice is heard at committee meetings." />
            <p id="nom-bio-count" className="field-helper char-count" aria-live="polite">{bio.length}/500 characters</p>
          </div>
          <div className="form-actions">
            {p && p.status !== 'withdrawn' && <button type="button" className="btn btn-secondary" onClick={() => setConfirmWithdraw(true)} disabled={busy}>Withdraw</button>}
            <button className="btn btn-primary" disabled={busy || !name.trim() || !region}>{p ? (p.status === 'rejected' ? 'Submit again' : p.status === 'withdrawn' ? 'Submit my profile' : 'Save changes') : 'Submit my profile'}</button>
          </div>
        </form>
      )}
      {info.state === 'open' && p?.status === 'approved' && (
        <section className="card card-pad">
          <h2>Your profile</h2>
          <div className="row-top"><Thumb url={p.photoUrl} name={p.name} size="lg" /><div><strong>{p.name}</strong>{p.bio && <p className="muted">{p.bio}</p>}</div></div>
          <div className="form-actions"><button className="btn btn-secondary" onClick={() => setConfirmWithdraw(true)} disabled={busy}>Withdraw</button></div>
        </section>
      )}
      {confirmWithdraw && (
        <Dialog title="Withdraw your nomination?" confirmLabel="Withdraw" danger busy={busy} onConfirm={() => void withdraw()} onCancel={() => setConfirmWithdraw(false)}>
          <p>You will not appear on the ballot for {info.position.title}. You can submit your profile again while nominations are open.</p>
        </Dialog>
      )}
    </div>
  );
}
