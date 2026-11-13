import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { api, fmtDate, fromLocalInput, toLocalInput, type CampaignDetail, type Nomination, type Position, type Region } from '../../api';
import { Icon } from '../../icons';
import { Dialog, ErrorBox, SectionTitle, Spinner, Thumb } from '../../ui';

/**
 * The campaign's positions as a grid of blocks (Press Secretary, Finance Officer ...). Each block shows its approved candidates, its
 * nomination status and, once the campaign has closed, its turnout and winner. Positions are edited while the campaign is a draft;
 * candidates apply through a nomination link and are approved or rejected here. Only approved candidates reach the ballot.
 */

const NOMINATION_LABEL: Record<Position['nomination_state'], string> = {
  not_invited: 'No nomination link yet', open: 'Nominations open', closed: 'Nominations closed', expired: 'Nominations ended', ended: 'Nominations ended',
};
const STATUS_LABEL: Record<NonNullable<Nomination['status']>, string> = {
  invited: 'Invited', submitted: 'Waiting for review', approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrew',
};

export const needsMore = (p: Position) => p.counts.approved < p.required;

/** Why the campaign cannot start yet, or null. Every position needs enough APPROVED candidates (at least 2, or its own minimum). */
export function startBlocker(positions: Position[]): string | null {
  if (positions.length === 0) return 'Add at least one position to start.';
  const short = positions.filter(needsMore);
  if (short.length) return `Every position needs at least 2 approved candidates (or its own minimum). Still short: ${short.map((p) => p.title).join(', ')}.`;
  return null;
}

// ---- add / edit a position -------------------------------------------------------------------------------------------------------

function PositionDialog({ c, existing, live, onDone, onCancel }: { c: CampaignDetail; existing?: Position; live: boolean; onDone: () => void; onCancel: () => void }) {
  const [title, setTitle] = useState(existing?.title ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [seats, setSeats] = useState(String(existing?.seats ?? 1));
  const [min, setMin] = useState(existing?.min_candidates ? String(existing.min_candidates) : '');
  const [max, setMax] = useState(existing?.max_candidates ? String(existing.max_candidates) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true); setError(null);
    const body = live ? { title, description: description || null }
      : { title, description: description || null, seats: Number(seats) || 1, min_candidates: min ? Number(min) : null, max_candidates: max ? Number(max) : null };
    try {
      if (existing) await api('PATCH', `/api/campaigns/${c.id}/positions/${existing.id}`, body);
      else await api('POST', `/api/campaigns/${c.id}/positions`, body);
      onDone();
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return (
    <Dialog title={existing ? `Edit ${existing.title}` : 'Add a position'} confirmLabel={existing ? 'Save position' : 'Add position'} busy={busy} confirmDisabled={!title.trim()} onConfirm={() => void save()} onCancel={onCancel}>
      <div className="stack">
        <label>Title<span className="field-helper">For example “Press Secretary”. Shown to voters on the position block.</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required /></label>
        <label>Description<span className="field-helper">Optional.</span><textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} /></label>
        {!live && (
          <div className="field-grid">
            <label>Seats<span className="field-helper">Kept for future election rules. Today the candidate with the most votes wins.</span><input type="number" min={1} max={50} value={seats} onChange={(e) => setSeats(e.target.value)} /></label>
            <label>Fewest candidates<span className="field-helper">Optional. Default 2.</span><input type="number" min={1} max={500} value={min} onChange={(e) => setMin(e.target.value)} /></label>
            <label>Most candidates<span className="field-helper">Optional.</span><input type="number" min={1} max={500} value={max} onChange={(e) => setMax(e.target.value)} /></label>
          </div>
        )}
        {live && <p className="field-helper">Voting is open: only the title and description can change. The change is recorded and shown to voters.</p>}
        <ErrorBox message={error} />
      </div>
    </Dialog>
  );
}

// ---- add / edit a candidate ------------------------------------------------------------------------------------------------------

function CandidateForm({ c, position, existing, onDone, onCancel }: { c: CampaignDetail; position: Position; existing?: Nomination; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(existing?.name ?? '');
  const [bio, setBio] = useState(existing?.bio ?? '');
  const [region, setRegion] = useState(existing?.region_id ?? '');
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
    if (existing) fd.append('region_id', region); else { fd.append('position_id', position.id); if (region) fd.append('region_id', region); }
    if (file) fd.append('photo', file);
    if (existing && removePhoto) fd.append('removePhoto', 'true');
    try { await api(existing ? 'PATCH' : 'POST', `/api/campaigns/${c.id}/candidates${existing ? `/${existing.id}` : ''}`, fd); onDone(); }
    catch (err) { setError((err as Error).message); setBusy(false); }
  }
  const shown = preview ?? (removePhoto ? null : existing?.photo_url ?? null);
  return (
    <form className="inline-form stack" onSubmit={(e) => void submit(e)} aria-label={existing ? `Edit ${existing.name}` : `Add a candidate for ${position.title}`}>
      <h4>{existing ? 'Edit candidate' : `Add a candidate for ${position.title}`}</h4>
      <div className="row-top">
        <Thumb url={shown} name={name || '?'} size="lg" />
        <div className="stack grow">
          <label>Photo<span className="field-helper">JPEG or PNG, max 2 MB.</span><input ref={input} type="file" accept="image/jpeg,image/png" onChange={(e) => pick(e.target.files?.[0] ?? null)} /></label>
          {existing?.photo_url && !file && <label className="check"><input type="checkbox" checked={removePhoto} onChange={(e) => setRemovePhoto(e.target.checked)} /> Remove current photo</label>}
        </div>
      </div>
      <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></label>
      <label>Region<select value={region} onChange={(e) => setRegion(e.target.value)}><option value="">No region</option>{(c.regions ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
      <label>Short bio <span className="field-helper">{bio.length}/500 characters</span><textarea rows={3} value={bio} onChange={(e) => setBio(e.target.value)} maxLength={500} /></label>
      <ErrorBox message={error} />
      <div className="form-actions">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !name.trim()}>{existing ? 'Save candidate' : 'Add candidate'}</button>
      </div>
    </form>
  );
}

// ---- the nomination link ---------------------------------------------------------------------------------------------------------

function InvitePanel({ c, p, reload }: { c: CampaignDetail; p: Position; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  async function run(fn: () => Promise<unknown>) { setBusy(true); setError(null); try { await fn(); await reload(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  async function copy() {
    if (!p.invite_url) return;
    try { await navigator.clipboard.writeText(p.invite_url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError('Copy failed: select the link and copy it by hand.'); }
  }
  if (c.status !== 'draft') return <p className="field-helper" role="note">Nominations closed when voting started.</p>;
  const qr = `/api/campaigns/${c.id}/positions/${p.id}/invite.png`;
  return (
    <div className="invite-panel">
      <h4>Candidate nominations</h4>
      {!p.invite_url
        ? (
          <>
            <p className="field-helper">Candidates apply themselves: they open a link, sign in with Microsoft and fill in their own profile. You then approve or reject each one. The link stops working when voting starts{c.nominations_close_at ? ` (or ${fmtDate(c.nominations_close_at)})` : ''}.</p>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run(() => api('POST', `/api/campaigns/${c.id}/positions/${p.id}/invite`))}>Invite candidates</button>
          </>
        )
        : (
          <>
            <div className="invite-row">
              <label className="grow">Nomination link for {p.title}<input readOnly value={p.invite_url} onFocus={(e) => e.currentTarget.select()} /></label>
              <button className="btn btn-secondary btn-sm" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</button>
            </div>
            <div className="invite-qr">
              <img src={qr} alt={`QR code for the ${p.title} nomination link`} width={160} height={160} />
              <div className="stack">
                <a className="btn btn-secondary btn-sm" href={`${qr}?download=1`} download><Icon name="download" /> Download QR code</a>
                <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void run(() => api('PATCH', `/api/campaigns/${c.id}/positions/${p.id}`, { status: p.status === 'open' ? 'closed' : 'open' }))}>
                  {p.status === 'open' ? 'Close nominations' : 'Reopen nominations'}
                </button>
                <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void run(() => api('DELETE', `/api/campaigns/${c.id}/positions/${p.id}/invite`))}>Turn the link off</button>
              </div>
            </div>
          </>
        )}
      <ErrorBox message={error} />
    </div>
  );
}

// ---- one position: candidates, review ---------------------------------------------------------------------------------------------

function PositionDetail({ c, p, reload, editable, canEditPosition }: { c: CampaignDetail; p: Position; reload: () => Promise<void>; editable: boolean; canEditPosition: boolean }) {
  const [list, setList] = useState<Nomination[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Nomination | 'new' | null>(null);
  const [rejecting, setRejecting] = useState<Nomination | null>(null);
  const [withdrawing, setWithdrawing] = useState<Nomination | null>(null);
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setList((await api<{ nominations: Nomination[] }>('GET', `/api/campaigns/${c.id}/positions/${p.id}/nominations`)).nominations); setError(null); } catch (e) { setError((e as Error).message); }
  }, [c.id, p.id]);
  useEffect(() => { void load(); }, [load, p.counts.approved, p.counts.submitted, p.counts.rejected, p.counts.withdrawn]);
  const refresh = async () => { await load(); await reload(); };
  async function act(fn: () => Promise<unknown>) { setBusy(true); setError(null); try { await fn(); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  const withdrawnIds = new Set(c.candidates.filter((x) => x.withdrawn_at).map((x) => x.id));
  const inRunning = (list ?? []).filter((x) => x.status === 'approved' && !withdrawnIds.has(x.id)).length;

  return (
    <section className="card card-pad position-detail" aria-label={`${p.title} details`}>
      <h3>{p.title}</h3>
      {p.description && <p className="muted">{p.description}</p>}
      <p className="muted small">{p.counts.approved} approved{p.required > 2 || p.min_candidates ? ` (needs at least ${p.required})` : ' (needs at least 2)'}{p.max_candidates ? ` · at most ${p.max_candidates}` : ''} · {p.seats} seat{p.seats === 1 ? '' : 's'}</p>
      <InvitePanel c={c} p={p} reload={refresh} />
      <ErrorBox message={error} />
      <div className="section-title"><h4>Candidates</h4>
        {editable && !editing && <div className="section-actions"><button className="btn btn-secondary btn-sm" onClick={() => setEditing('new')}>+ Add a candidate myself</button></div>}
      </div>
      {!list && !error && <Spinner />}
      {list && list.length === 0 && <p className="muted">No candidates yet. Send the nomination link, or add one yourself.</p>}
      {list && list.length > 0 && (
        <ul className="cand-list">
          {list.map((x) => (
            <li key={x.id} className="cand-row nomination-row">
              <Thumb url={x.photo_url} name={x.name} />
              <div className="grow">
                <strong>{x.name}</strong> <span className={`chip ${x.status === 'approved' ? 'chip-open' : x.status === 'submitted' ? 'chip-outline' : 'chip-draft'}`}>{STATUS_LABEL[x.status]}</span>
                {withdrawnIds.has(x.id) && <span className="chip chip-outline">Withdrew from the vote</span>}
                <div className="muted small">{x.region ?? 'No region'}{x.submitted_by ? ` · applied by ${x.submitted_by} (${x.submitted_by_email})` : ' · added by an administrator'}{x.submitted_at ? ` · ${fmtDate(x.submitted_at)}` : ''}</div>
                {x.bio && <div className="muted small">{x.bio}</div>}
                {x.status === 'rejected' && x.review_reason && <div className="small">Rejected: {x.review_reason}</div>}
              </div>
              <div className="cand-actions">
                {c.status === 'draft' && (x.status === 'submitted' || x.status === 'rejected') && <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void act(() => api('POST', `/api/campaigns/${c.id}/candidates/${x.id}/approve`))} aria-label={`Approve ${x.name}`}>Approve</button>}
                {c.status === 'draft' && (x.status === 'submitted' || x.status === 'approved') && <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setWhy(''); setRejecting(x); }} aria-label={`Reject ${x.name}`}>Reject…</button>}
                {editable && <button className="btn-text" onClick={() => setEditing(x)} aria-label={`Edit ${x.name}`}>Edit</button>}
                {editable && <button className="btn-text btn-text-danger" disabled={busy} onClick={() => void act(() => api('DELETE', `/api/campaigns/${c.id}/candidates/${x.id}`))} aria-label={`Remove ${x.name}`}>Remove</button>}
                {c.status === 'open' && x.status === 'approved' && !withdrawnIds.has(x.id) && (
                  <button className="btn btn-secondary btn-sm" disabled={inRunning <= 2} title={inRunning <= 2 ? 'At least 2 candidates must stay in the running' : undefined} onClick={() => { setWhy(''); setWithdrawing(x); }} aria-label={`Withdraw ${x.name}`}>Withdraw…</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing && editable && <CandidateForm key={editing === 'new' ? 'new' : editing.id} c={c} position={p} existing={editing === 'new' ? undefined : editing} onDone={() => { setEditing(null); void refresh(); }} onCancel={() => setEditing(null)} />}
      {canEditPosition && <p className="field-helper">Pending or rejected profiles never appear on the ballot, and do not count towards the candidates needed to start.</p>}

      {rejecting && (
        <Dialog title={`Reject ${rejecting.name}?`} confirmLabel="Reject profile" danger busy={busy} confirmDisabled={why.trim().length < 5}
          onConfirm={() => { const x = rejecting; setRejecting(null); void act(() => api('POST', `/api/campaigns/${c.id}/candidates/${x.id}/reject`, { reason: why.trim() })); }} onCancel={() => setRejecting(null)}>
          <p>They will not appear on the ballot. They see your reason and can fix the profile and send it again.</p>
          <label>Reason<span className="field-helper">At least 5 characters. Shown to the candidate and kept in the audit log.</span><textarea rows={3} value={why} onChange={(e) => setWhy(e.target.value)} maxLength={1000} /></label>
        </Dialog>
      )}
      {withdrawing && (
        <Dialog title={`${withdrawing.name} withdraws?`} confirmLabel="Withdraw candidate" danger busy={busy} confirmDisabled={why.trim().length < 10}
          onConfirm={() => { const x = withdrawing; setWithdrawing(null); void act(() => api('POST', `/api/campaigns/${c.id}/candidates/${x.id}/withdraw`, { reason: why.trim() })); }} onCancel={() => setWithdrawing(null)}>
          <p>{withdrawing.name} stays on the ballot but can no longer be chosen. Votes already cast for them become void. This cannot be undone.</p>
          <label>Reason<span className="field-helper">At least 10 characters. Voters will see it on the ballot page and in the published results.</span><textarea rows={3} value={why} onChange={(e) => setWhy(e.target.value)} maxLength={1000} /></label>
        </Dialog>
      )}
    </section>
  );
}

// ---- the grid ---------------------------------------------------------------------------------------------------------------------

export function PositionsTab({ c, reload }: { c: CampaignDetail; reload: () => Promise<void> }) {
  const positions = c.positions ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'add' | Position | null>(null);
  const [removing, setRemoving] = useState<Position | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const draft = c.status === 'draft';
  const live = c.status === 'open' && !!c.allow_edits_after_start;
  const candidatesEditable = draft || (live && c.turnout === 0);
  const sel = positions.find((p) => p.id === selected) ?? null;

  async function move(p: Position, dir: -1 | 1) {
    const i = positions.findIndex((x) => x.id === p.id);
    const ids = positions.map((x) => x.id);
    [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
    setBusy(true); setError(null);
    try { await api('POST', `/api/campaigns/${c.id}/positions/reorder`, { ids }); await reload(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function remove() {
    if (!removing) return;
    setBusy(true); setError(null);
    try { await api('DELETE', `/api/campaigns/${c.id}/positions/${removing.id}`); if (selected === removing.id) setSelected(null); setRemoving(null); await reload(); }
    catch (e) { setError((e as Error).message); setRemoving(null); } finally { setBusy(false); }
  }
  const blocker = draft ? startBlocker(positions) : null;

  return (
    <>
      <SectionTitle icon="users" actions={draft ? <button className="btn btn-secondary btn-sm" onClick={() => setDialog('add')}>+ Add a position</button> : undefined}>Positions</SectionTitle>
      {c.allow_abstain && <p className="muted small">Every position ends with an “Abstain (none of the above)” option. It is not a candidate and never counts towards the 2 needed.</p>}
      {draft && <p className="field-helper">Voters see one block per position. To start, every position needs at least 2 approved candidates (or its own minimum).</p>}
      <ErrorBox message={error} />
      {positions.length === 0 && <p className="muted">No positions yet. Add the first one, for example “Press Secretary”.</p>}
      <ul className="position-grid admin-position-grid" aria-label="Positions">
        {positions.map((p, i) => (
          <li key={p.id}>
            <article className={`position-card${selected === p.id ? ' position-selected' : ''}${draft && needsMore(p) ? ' position-short' : ''}`} aria-label={p.title}>
              <h3 className="position-title">{p.title}</h3>
              <div className="position-chips">
                <span className={`chip ${needsMore(p) && draft ? 'chip-draft' : 'chip-open'}`}>{p.counts.approved} approved</span>
                {p.counts.submitted > 0 && <span className="chip chip-outline">{p.counts.submitted} to review</span>}
                <span className="chip chip-outline">{NOMINATION_LABEL[p.nomination_state]}</span>
              </div>
              {draft && needsMore(p) && <p className="small position-need">Needs at least {p.required} approved</p>}
              {p.result && (
                <p className="small position-outcome">{p.result.turnout} voted · {p.result.tie ? <>Tie: {p.result.tie.join(' and ')}</> : p.result.winners.length ? <>Winner: <strong>{p.result.winners.join(', ')}</strong></> : 'No winner'}</p>
              )}
              <div className="position-actions">
                <button className="btn btn-secondary btn-sm" aria-pressed={selected === p.id} onClick={() => setSelected(selected === p.id ? null : p.id)}>{selected === p.id ? 'Hide' : draft ? 'Manage' : 'View'}</button>
                {(draft || live) && <button className="btn-text" onClick={() => setDialog(p)} aria-label={`Edit ${p.title}`}>Edit</button>}
                {draft && <button className="btn-text" disabled={busy || i === 0} onClick={() => void move(p, -1)} aria-label={`Move ${p.title} up`}>↑</button>}
                {draft && <button className="btn-text" disabled={busy || i === positions.length - 1} onClick={() => void move(p, 1)} aria-label={`Move ${p.title} down`}>↓</button>}
                {draft && <button className="btn-text btn-text-danger" onClick={() => setRemoving(p)} aria-label={`Remove ${p.title}`}>Remove</button>}
              </div>
            </article>
          </li>
        ))}
      </ul>
      {blocker && positions.length > 0 && <p className="field-helper" role="note">{blocker}</p>}
      {sel && <PositionDetail key={sel.id} c={c} p={sel} reload={reload} editable={candidatesEditable} canEditPosition={draft} />}

      {dialog && <PositionDialog c={c} existing={dialog === 'add' ? undefined : dialog} live={live && !draft} onDone={() => { setDialog(null); void reload(); }} onCancel={() => setDialog(null)} />}
      {removing && (
        <Dialog title={`Remove ${removing.title}?`} confirmLabel="Remove position" danger busy={busy} onConfirm={() => void remove()} onCancel={() => setRemoving(null)}>
          <p>This removes the position and all of its candidates and nomination link. This can't be undone.</p>
        </Dialog>
      )}
    </>
  );
}

// ---- settings: nominations, results view, regions ---------------------------------------------------------------------------------

function RegionsEditor({ c, reload }: { c: CampaignDetail; reload: () => Promise<void> }) {
  const [list, setList] = useState<Region[]>(c.regions ?? []);
  const [adding, setAdding] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setList(c.regions ?? []); }, [c.regions]);
  const draft = c.status === 'draft';
  async function run(fn: () => Promise<unknown>) { setBusy(true); setError(null); try { await fn(); await reload(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }
  return (
    <section className="regions-editor" aria-label="Regions">
      <SectionTitle icon="flag">Regions</SectionTitle>
      <p className="field-helper">{draft ? 'Candidates choose their region from this list, and voters can filter the ballot by it. It starts as the 14 regions of Namibia; rename, add or remove them to use NamRA’s own office regions. A region that has candidates cannot be removed.' : 'Locked: voting has started.'}</p>
      <ErrorBox message={error} />
      <ul className="region-list">
        {list.map((r) => (
          <li key={r.id} className="region-item">
            {editing?.id === r.id
              ? (
                <form className="region-edit" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('PATCH', `/api/campaigns/${c.id}/regions/${r.id}`, { name: editing.name }); setEditing(null); }); }}>
                  <label className="sr-only" htmlFor={`rn-${r.id}`}>Region name</label>
                  <input id={`rn-${r.id}`} value={editing.name} onChange={(e) => setEditing({ id: r.id, name: e.target.value })} maxLength={80} required />
                  <button className="btn btn-primary btn-sm" disabled={busy || !editing.name.trim()}>Save</button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                </form>
              )
              : (
                <>
                  <span>{r.name}</span>
                  {draft && (
                    <span className="cand-actions">
                      <button className="btn-text" onClick={() => setEditing({ id: r.id, name: r.name })} aria-label={`Rename ${r.name}`}>Rename</button>
                      <button className="btn-text btn-text-danger" disabled={busy} onClick={() => void run(() => api('DELETE', `/api/campaigns/${c.id}/regions/${r.id}`))} aria-label={`Remove ${r.name}`}>Remove</button>
                    </span>
                  )}
                </>
              )}
          </li>
        ))}
      </ul>
      {draft && (
        <form className="region-add" onSubmit={(e) => { e.preventDefault(); void run(async () => { await api('POST', `/api/campaigns/${c.id}/regions`, { name: adding }); setAdding(''); }); }}>
          <label>Add a region<input value={adding} onChange={(e) => setAdding(e.target.value)} maxLength={80} /></label>
          <button className="btn btn-secondary btn-sm" disabled={busy || !adding.trim()}>Add region</button>
        </form>
      )}
    </section>
  );
}

export function SettingsTab({ c, reload }: { c: CampaignDetail; reload: () => Promise<void> }) {
  const draft = c.status === 'draft';
  const [closeAt, setCloseAt] = useState(toLocalInput(c.nominations_close_at ?? null));
  const [who, setWho] = useState<string>(c.nominate_eligibility ?? '');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function saveNominations(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null); setMsg(null);
    try { await api('PATCH', `/api/campaigns/${c.id}`, { nominations_close_at: fromLocalInput(closeAt), nominate_eligibility: who || null }); setMsg('Saved.'); await reload(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  async function setGroup(on: boolean) {
    setBusy(true); setError(null);
    try { await api('PUT', `/api/campaigns/${c.id}/results-view`, { group_by_region: on }); await reload(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  const voters = c.eligibility === 'all' ? 'all signed-in staff' : c.eligibility === 'umoja' ? 'Umoja members only' : 'the people on the voter list';
  return (
    <>
      <form onSubmit={(e) => void saveNominations(e)} className="form-section">
        <SectionTitle icon="calendar">Nominations</SectionTitle>
        <div className="stack">
          <label>Nominations close at<span className="field-helper">{draft ? 'Optional. Windhoek time (CAT). Nominations always close when voting starts.' : 'Locked: nominations closed when voting started.'}</span>
            <input type="datetime-local" value={closeAt} onChange={(e) => setCloseAt(e.target.value)} disabled={!draft} /></label>
          <label>Who can nominate themselves<span className="field-helper">{draft ? `By default the same people who can vote (${voters}).` : 'Locked.'}</span>
            <select value={who} onChange={(e) => setWho(e.target.value)} disabled={!draft}>
              <option value="">Same as the voters</option>
              <option value="umoja">Umoja members only</option>
              <option value="all">All signed-in staff</option>
            </select></label>
        </div>
        {draft && <div className="form-actions"><button className="btn btn-secondary" disabled={busy}>Save nomination settings</button>{msg && <span className="ok">{msg}</span>}</div>}
      </form>
      <section className="form-section">
        <SectionTitle icon="chart">Results</SectionTitle>
        <label className="check"><input type="checkbox" checked={!!c.results_group_by_region} disabled={busy} onChange={(e) => void setGroup(e.target.checked)} /> Show results grouped by region</label>
        <p className="field-helper">Applies to the results page, published results and the CSV, Excel and PDF exports. You can change it at any time.</p>
      </section>
      <ErrorBox message={error} />
      <RegionsEditor c={c} reload={reload} />
    </>
  );
}
