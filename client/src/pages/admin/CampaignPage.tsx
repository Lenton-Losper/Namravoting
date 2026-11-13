import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fmtDate, fromLocalInput, type Campaign, type CampaignDetail, type Results, type SealCheck } from '../../api';
import { Icon } from '../../icons';
import { SharePanel } from '../../share';
import { TeamTab } from './TeamTab';
import { NotifyPanel } from './NotifyPanel';
import { LateVoters } from './LateVoters';
import { BackLink, Dialog, ErrorBox, Field, NoticeList, quorumLine, ResultsChart, SectionTitle, Spinner, StatusBadge, Tabs, Thumb, TurnoutBar, initials } from '../../ui';

type Tab = 'candidates' | 'eligibility' | 'results' | 'team';

/**
 * While a campaign is open the server returns turnout only (SEC-01), so polling is harmless: it never carries per-candidate
 * counts. `version` re-fetches once when the vote count changes (a reset changes it without changing the status).
 */
function useResults(id: string, enabled: boolean, poll: boolean, version?: number) {
  const [r, setR] = useState<Results | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const tick = () => api<Results>('GET', `/api/campaigns/${id}/results`).then((x) => { if (alive) { setR(x); setErr(null); } }).catch((e: Error) => alive && setErr(e.message));
    void tick();
    if (!poll) return () => { alive = false; };
    const t = setInterval(() => void tick(), 15000);   // turnout only: every 15 s
    return () => { alive = false; clearInterval(t); };
  }, [id, enabled, poll, version]);
  return { r, err };
}

function CandidatesTab({ c, reload }: { c: CampaignDetail; reload: () => Promise<void> }) {
  const [target, setTarget] = useState<{ id: string; name: string } | null>(null);
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inRunning = c.candidates.filter((x) => !x.withdrawn_at).length;
  async function withdraw() {
    if (!target) return;
    setBusy(true); setErr(null);
    try { await api('POST', `/api/campaigns/${c.id}/candidates/${target.id}/withdraw`, { reason: why.trim() }); setTarget(null); setWhy(''); await reload(); }
    catch (e) { setErr((e as Error).message); setTarget(null); } finally { setBusy(false); }
  }
  const editable = c.status === 'draft' || (c.status === 'open' && !!c.allow_edits_after_start && c.turnout === 0);   // after the first vote the candidates are fixed
  return (
    <>
      {c.allow_abstain && <p className="muted small">The ballot ends with an “Abstain (none of the above)” option. It is not a candidate and never counts towards the 2 needed.</p>}
      <SectionTitle icon="users" actions={editable ? <Link className="btn btn-secondary btn-sm" to={`/admin/c/${c.id}/edit`}>Edit candidates</Link> : undefined}>Candidates</SectionTitle>
      {c.candidates.length === 0
        ? <p className="muted">No candidates yet.</p>
        : (
          <ul className="cand-list">
            {c.candidates.map((x) => (
              <li key={x.id} className="cand-row">
                <Thumb url={x.photo_url} name={x.name} />
                <div className="grow"><strong>{x.name}</strong>{x.withdrawn_at && <span className="chip chip-outline">Withdrew</span>}{x.bio && <div className="muted small">{x.bio}</div>}{x.withdrawn_reason && <div className="muted small">Withdrew: {x.withdrawn_reason}</div>}</div>
                {c.status === 'open' && !x.withdrawn_at && <button className="btn btn-secondary btn-sm" disabled={inRunning <= 2} title={inRunning <= 2 ? 'At least 2 candidates must stay in the running' : undefined} onClick={() => { setWhy(''); setErr(null); setTarget({ id: x.id, name: x.name }); }}>Withdraw…</button>}
              </li>
            ))}
          </ul>
        )}
      <ErrorBox message={err} />
      {c.status === 'open' && <p className="field-helper">If a candidate withdraws, they stay on the ballot but cannot be chosen. Votes already cast for them are void: they count in turnout but never for a winner. Votes are secret, so voters cannot be asked to vote again; use Reset votes if everyone should vote again.</p>}
      {target && (
        <Dialog title={`${target.name} withdraws?`} confirmLabel="Withdraw candidate" danger busy={busy} confirmDisabled={why.trim().length < 10} onConfirm={() => void withdraw()} onCancel={() => setTarget(null)}>
          <p>{target.name} stays on the ballot but can no longer be chosen. Votes already cast for them become void. This cannot be undone.</p>
          <label>Reason<span className="field-helper">At least 10 characters. Voters will see it on the ballot page and in the published results.</span>
            <textarea value={why} onChange={(e) => setWhy(e.target.value)} rows={3} maxLength={1000} /></label>
        </Dialog>
      )}
    </>
  );
}

function EligibilityTab({ c, reload }: { c: CampaignDetail; reload: () => Promise<void> }) {
  return (
    <>
      <SectionTitle icon="lock" actions={c.status === 'draft' ? <Link className="btn btn-secondary btn-sm" to={`/admin/c/${c.id}/edit`}>Edit eligibility</Link> : undefined}>Who can vote</SectionTitle>
      <div className="field-grid">
        <Field label="Eligible voters" helper="Who may take part in this vote">{c.eligibility === 'all' ? 'All signed-in NamRA staff' : c.eligibility === 'umoja' ? `Umoja members only (${c.umoja_active_count} active member${c.umoja_active_count === 1 ? '' : 's'})` : `${c.eligible_emails.length} listed email address${c.eligible_emails.length === 1 ? '' : 'es'}`}</Field>
        <Field label="Votes per person" helper="Enforced by the system">One</Field>
      </div>
      {c.eligibility === 'list' && (
        <Field label="Voter list">
          <ul className="email-list">{c.eligible_emails.map((e) => <li key={e}>{e}</li>)}</ul>
        </Field>
      )}
      <LateVoters c={c} reload={reload} />
    </>
  );
}

/** SEC-16: receipts and tallies disagree, so closing is blocked until the creator has investigated and says so. */
function IntegrityBanner({ c, reload }: { c: CampaignDetail; reload: () => Promise<void> }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const b = c.integrity_block;
  if (!b) return null;
  async function ack() {
    setBusy(true); setErr(null);
    try { await api('POST', `/api/campaigns/${c.id}/integrity/acknowledge`, { note: note.trim() }); setNote(''); await reload(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <section className="admin-banner admin-banner-danger" role="alert">
      <p><strong>Closing is blocked: receipts ({b.receipts}) and tallies ({b.ballots}) do not match.</strong> Something changed the vote data outside the app. Look into it (the audit log has the details) before you go on.</p>
      <label>What did you find? <span className="field-helper">At least 10 characters. It is kept in the audit log and sealed with the result.</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={1000} /></label>
      <ErrorBox message={err} />
      <button className="btn btn-danger btn-sm" disabled={busy || note.trim().length < 10} onClick={() => void ack()}>I investigated: allow closing</button>
    </section>
  );
}

// TODO(re-enable): not rendered at the moment (see ResultsTab). Kept so it can be switched back on.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function SealPanel({ id }: { id: string }) {
  const [v, setV] = useState<SealCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true); setErr(null);
    try { setV(await api<SealCheck>('GET', `/api/campaigns/${id}/verify`)); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }
  const good = !!v && v.chain_ok && v.sealed && v.tallies_match !== false && v.receipts_match !== false;
  return (
    <div className="seal-panel">
      <button className="btn btn-secondary btn-sm" onClick={() => void run()} disabled={busy}>{busy ? 'Checking…' : 'Verify results integrity'}</button>
      <ErrorBox message={err} />
      {v && (
        <div role="status">
          <p className={good ? 'ok' : 'bad'}>{good ? 'Verified: the result is sealed in the audit chain and nothing has changed since.' : 'NOT verified: see the checks below and investigate before publishing.'}</p>
          <ul className="list small">
            <li>Audit chain ({v.chain_checked} entries): {v.chain_ok ? 'intact' : 'BROKEN'}</li>
            <li>Result sealed at close: {v.sealed ? `yes (${v.sealed_at ? fmtDate(v.sealed_at) : ''})` : 'NO'}</li>
            <li>Counters equal the sealed tallies: {v.tallies_match === null ? 'n/a' : v.tallies_match ? 'yes' : 'NO'}</li>
            <li>Receipts equal the sealed turnout: {v.receipts_match === null ? 'n/a' : v.receipts_match ? `yes (${v.sealed_turnout})` : 'NO'}</li>
          </ul>
          {v.seal_hash && <p className="muted small">Seal fingerprint: <code>{v.seal_hash}</code></p>}
        </div>
      )}
    </div>
  );
}

/** Tie handling: a tie for first place goes to a run-off, a new draft campaign with the tied candidates and the same voters. */
function RunoffPanel({ id, tie, info }: { id: string; tie: Results['tie'] | null; info: NonNullable<Results['runoff']> }) {
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    setBusy(true); setError(null);
    try { const n = await api<Campaign>('POST', `/api/campaigns/${id}/runoff`); nav(`/admin/c/${n.id}`); } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  return (
    <div className="runoff-panel">
      {info.parent && <p className="muted small">This is run-off round {info.round} of <Link to={`/admin/c/${info.parent.id}`}>{info.parent.title}</Link>.</p>}
      {info.next && <p>A run-off was started: <Link to={`/admin/c/${info.next.id}`}>{info.next.title}</Link> ({info.next.status}).</p>}
      {tie && !info.next && (info.can_start
        ? <><p>The tie goes to a run-off between {tie.names.join(' and ')}. It is created as a draft with the same voters; you start it like any campaign. Run-off {info.round + 1} of at most {info.max}.</p>
            <button className="btn btn-primary" onClick={() => void start()} disabled={busy}>Start run-off</button></>
        : <p className="muted">The limit of {info.max} run-off rounds has been reached. The tie has to be decided another way.</p>)}
      <ErrorBox message={error} />
    </div>
  );
}

function ResultsTab({ c, reload }: { c: CampaignDetail; reload: () => Promise<void> }) {
  const { r, err } = useResults(c.id, c.status !== 'draft', c.status === 'open', c.turnout);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // If the campaign auto-closed (closes_at passed) while we were watching, refresh the page state.
  useEffect(() => { if (c.status === 'open' && r?.status === 'closed') void reload(); }, [c.status, r?.status, reload]);

  const [askBelow, setAskBelow] = useState(false);
  const [when, setWhen] = useState('');
  async function publish(acknowledge = false) {
    setBusy(true); setError(null);
    try { await api('POST', `/api/campaigns/${c.id}/publish`, acknowledge ? { acknowledge_below_quorum: true } : {}); setAskBelow(false); await reload(); } catch (e) { setError((e as Error).message); setAskBelow(false); } finally { setBusy(false); }
  }
  async function schedule(at: string | null) {
    setBusy(true); setError(null);
    try { await api('PUT', `/api/campaigns/${c.id}/publish-schedule`, { publish_at: at }); setWhen(''); await reload(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <>
      <SectionTitle icon="chart" actions={c.status === 'closed' ? (
        <>
          {c.results_published
            ? <span className="chip chip-open">Published to voters</span>
            : <button className="btn btn-primary btn-sm" onClick={() => (r?.quorum?.met === false ? setAskBelow(true) : void publish())} disabled={busy}>Publish results</button>}
          <a className="btn btn-secondary btn-sm" href={`/api/campaigns/${c.id}/results.csv`} download><Icon name="download" /> Export CSV</a>
          <a className="btn btn-secondary btn-sm" href={`/api/campaigns/${c.id}/results.xlsx`} download><Icon name="download" /> Export Excel (.xlsx)</a>
          <a className="btn btn-secondary btn-sm" href={`/api/campaigns/${c.id}/results.pdf`} download><Icon name="download" /> Export PDF</a>
          <a className="btn btn-secondary btn-sm" href={`/api/campaigns/${c.id}/audit-bundle.zip`} download><Icon name="download" /> Audit bundle (.zip)</a>
        </>
      ) : undefined}>{c.status === 'open' ? 'Turnout' : 'Results'}{c.status === 'open' && <span className="muted count"> · updates every 15 s</span>}</SectionTitle>
      <ErrorBox message={err ?? error} />
      {c.status === 'draft' && <p className="muted">Results will appear here once voting has started.</p>}
      {c.status === 'open' && (r
        ? (
          <>
            <div className="results-turnout"><div className="field-label">Turnout</div><TurnoutBar votes={r.turnout.votes} eligible={r.turnout.eligible} /></div>
            <p className="muted">Per-candidate results are hidden until voting closes, for everyone including you. This protects the secrecy of every vote.</p>
          </>
        )
        : !err && <Spinner />)}
      {c.status === 'closed' && (r?.candidates ? <ResultsChart candidates={r.candidates} turnout={r.turnout} tie={r.tie} quorum={r.quorum} /> : !err && <Spinner />)}
      {c.status === 'closed' && r?.publication && <p className="muted small">Published by {r.publication.by ?? 'unknown'} on {fmtDate(r.publication.at)}{r.publication.scheduled ? ' (scheduled in advance)' : ''}.</p>}
      {(c.status === 'closed' || c.status === 'open') && !c.results_published && (
        <div className="schedule-panel">
          {c.publish_at
            ? <p>Results will be published automatically on {fmtDate(c.publish_at)}, approved by whoever scheduled it. <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void schedule(null)}>Cancel schedule</button></p>
            : (
              <label>Publish automatically at<span className="field-helper">Optional. Windhoek time (CAT). Checked whenever the campaign is opened; never before voting has closed, and not if the result is below quorum or does not match its seal.</span>
                <span className="row-between"><input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !when} onClick={() => void schedule(fromLocalInput(when))}>Schedule</button></span></label>
            )}
        </div>
      )}
      {askBelow && r?.quorum && (
        <Dialog title="Publish below the quorum?" confirmLabel="Publish anyway" danger busy={busy} onConfirm={() => void publish(true)} onCancel={() => setAskBelow(false)}>
          <p>{quorumLine(r.quorum)}</p><p>Voters will see that the result is below quorum. Publish only if that is acceptable under your rules.</p>
        </Dialog>
      )}
      {c.status === 'closed' && r?.runoff && <RunoffPanel id={c.id} tie={r.tie ?? null} info={r.runoff} />}
      {c.status === 'closed' && c.receipts_purged_at && <p className="muted small" role="note">The personal data of this campaign (who voted, the voter list, photos) was removed on {fmtDate(c.receipts_purged_at)} under the retention schedule. The sealed result and the audit trail remain.</p>}
      {/* TODO(re-enable): the "Verify results integrity" panel is hidden for now. Sealing, GET /api/campaigns/:id/verify and the publish block on a
          mismatch are unchanged on the server. Restore with:  {c.status === 'closed' && <SealPanel id={c.id} />}  */}
      <NoticeList notices={r?.notices} />
    </>
  );
}

type Dlg = 'start' | 'close' | 'deleteDraft' | 'archive' | 'unarchive' | 'permanent' | 'reset' | null;

function SideCard({ c, reload }: { c: CampaignDetail; reload: () => Promise<void> }) {
  const nav = useNavigate();
  const [dialog, setDialog] = useState<Dlg>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [closes, setCloses] = useState('');
  const archived = !!c.archived_at;
  const owner = c.my_role !== 'co_admin';   // co-admins run the campaign; reset, delete and archive stay with its creator
  const [notice, setNotice] = useState<string | null>(null);
  const blockedReason = c.candidates.length < 2 ? 'Add at least 2 candidates to start.'
    : c.eligibility === 'list' && c.eligible_emails.length === 0 ? 'Add at least one eligible email.' : null;
  const open = (d: Dlg) => { setTyped(''); setReason(''); setCloses(''); setError(null); setDialog(d); };

  async function run(fn: () => Promise<unknown>, after: () => Promise<void> | void) {
    setBusy(true); setError(null);
    try { await fn(); setDialog(null); await after(); }
    catch (e) { setError((e as Error).message); setDialog(null); } finally { setBusy(false); }
  }
  const post = (path: string, body?: unknown) => api('POST', `/api/campaigns/${c.id}/${path}`, body);
  const earlyClose = c.status === 'open' && !!c.closes_at && new Date(c.closes_at).getTime() > Date.now();   // a plain instant comparison: no time zone involved
  const titleOk = typed === c.title;
  const reasonOk = reason.trim().length >= 10;

  return (
    <aside className="card card-pad side-card">
      {c.status === 'draft' ? (
        <>
          <SectionTitle icon="flag">Actions</SectionTitle>
          <p className="field-helper">{c.allow_edits_after_start
            ? 'Starting opens the vote. Who can vote locks; the title, description and closing time stay editable, and candidates until the first vote is cast.'
            : 'Starting opens the vote and locks the campaign. Details, candidates and voters can no longer be changed.'}</p>
          <div className="stack">
            <button className="btn btn-primary" disabled={!!blockedReason} onClick={() => open('start')}>Start voting</button>
            {blockedReason && <p className="field-helper" role="note">{blockedReason}</p>}
            <Link className="btn btn-secondary" to={`/admin/c/${c.id}/edit`}>Edit campaign</Link>
            {owner && <button className="btn btn-danger" onClick={() => open('deleteDraft')}>Delete draft</button>}
          </div>
        </>
      ) : (
        <>
          <SectionTitle icon="link">Share</SectionTitle>
          <SharePanel c={c} compact />
          <NotifyPanel c={c} />
          <div className="stack side-close">
            {c.status === 'open' && c.allow_edits_after_start && <Link className="btn btn-secondary" to={`/admin/c/${c.id}/edit`}>Edit campaign</Link>}
            {c.status === 'open' && <button className="btn btn-danger" onClick={() => open('close')}>Close voting</button>}
            {c.status === 'open' && <p className="field-helper" role="note">Close the campaign first to archive or delete it.</p>}
            {owner && c.status === 'closed' && !archived && <button className="btn btn-secondary" onClick={() => open('archive')}>Archive</button>}
            {owner && archived && <button className="btn btn-secondary" onClick={() => open('unarchive')}>Unarchive</button>}
            {owner && archived && <button className="btn btn-danger" onClick={() => open('permanent')}>{c.require_approval ? 'Request permanent delete' : 'Delete permanently'}</button>}
            {owner && !archived && <button className="btn btn-danger" onClick={() => open('reset')}>{c.require_approval ? 'Request reset' : 'Reset votes'}</button>}
            {owner && archived && <p className="field-helper" role="note">Unarchive the campaign to reset its votes.</p>}
            {!owner && <p className="field-helper" role="note">You are a co-admin: you can run this campaign. Resetting, deleting, archiving and the team stay with its creator.</p>}
            {c.require_approval && owner && <p className="field-helper" role="note">A reset or a permanent delete needs a co-admin&rsquo;s approval (Team tab).</p>}
          </div>
        </>
      )}
      <ErrorBox message={error} />
      {notice && <p className="ok" role="status">{notice}</p>}

      {dialog === 'start' && (
        <Dialog title="Start voting?" confirmLabel="Start and lock" busy={busy} onConfirm={() => void run(() => post('start'), reload)} onCancel={() => setDialog(null)}>
          {c.allow_edits_after_start
            ? <p>This opens the vote and <strong>locks who can vote</strong>. You can still edit the title, description and closing time while it is open, and the candidates until the first vote is cast. Every edit is recorded and shown as “Edited after start”.</p>
            : <p>This <strong>locks the campaign</strong>. You will not be able to edit the details, candidates or eligible voters afterwards.</p>}
        </Dialog>
      )}
      {dialog === 'close' && (
        <Dialog title="Close voting now?" confirmLabel="Close voting" danger busy={busy} confirmDisabled={earlyClose && !reasonOk}
          onConfirm={() => void run(() => post('close', earlyClose ? { reason: reason.trim() } : {}), reload)} onCancel={() => setDialog(null)}>
          <p>No more votes will be accepted. This cannot be undone.</p>
          {earlyClose && (
            <label>Reason for closing early<span className="field-helper">At least 10 characters. Voters will see it on the ballot page and in the published results.</span>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} /></label>
          )}
        </Dialog>
      )}
      {dialog === 'deleteDraft' && (
        <Dialog title="Delete this draft?" confirmLabel="Delete draft" danger busy={busy}
          onConfirm={() => void run(() => api('DELETE', `/api/campaigns/${c.id}`), () => nav('/admin', { replace: true }))} onCancel={() => setDialog(null)}>
          <p>This permanently deletes the draft <strong>{c.title}</strong>, its candidates, voter list and uploaded photos. This can't be undone.</p>
        </Dialog>
      )}
      {dialog === 'archive' && (
        <Dialog title="Archive this campaign?" confirmLabel="Archive" busy={busy} onConfirm={() => void run(() => post('archive'), reload)} onCancel={() => setDialog(null)}>
          <p>It moves to the <strong>Archived</strong> tab and out of the dashboard stats. Its results stay viewable and exportable, and you can unarchive it any time.</p>
        </Dialog>
      )}
      {dialog === 'unarchive' && (
        <Dialog title="Unarchive this campaign?" confirmLabel="Unarchive" busy={busy} onConfirm={() => void run(() => post('unarchive'), reload)} onCancel={() => setDialog(null)}>
          <p>It returns to the Closed tab.</p>
        </Dialog>
      )}
      {dialog === 'permanent' && (
        <Dialog title={c.require_approval ? 'Request permanent delete?' : 'Delete permanently?'} confirmLabel={c.require_approval ? 'Send request' : 'Delete permanently'} danger busy={busy} confirmDisabled={!titleOk}
          onConfirm={() => void (c.require_approval
            ? run(() => post('approvals', { kind: 'permanent_delete', confirm_title: typed }), () => setNotice('Request sent. A co-admin must approve it in the Team tab, then you carry it out there.'))
            : run(() => post('permanent-delete', { confirm_title: typed }), () => nav('/admin', { replace: true })))} onCancel={() => setDialog(null)}>
          <p className="confirm-warning">This deletes the campaign, its {c.turnout} recorded {c.turnout === 1 ? 'vote' : 'votes'}, candidates and photos for good. This can't be undone. (The sealed result and a record of the deletion stay in the audit log.)</p>
          <p className="field-helper">You must have exported the results (CSV, Results tab) after the campaign closed, so a copy of the result exists outside the system.</p>
          <label>Type the campaign title to confirm<span className="field-helper">{c.title}</span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} /></label>
        </Dialog>
      )}
      {dialog === 'reset' && (
        <Dialog title={c.require_approval ? 'Request a reset of the votes?' : 'Reset votes?'} confirmLabel={c.require_approval ? 'Send request' : 'Reset votes'} danger busy={busy} confirmDisabled={!titleOk || !reasonOk}
          onConfirm={() => void (c.require_approval
            ? run(() => post('approvals', { kind: 'reset', confirm_title: typed, reason: reason.trim(), closes_at: fromLocalInput(closes) }), () => setNotice('Request sent. A co-admin must approve it in the Team tab, then you carry it out there.'))
            : run(() => post('reset', { confirm_title: typed, reason: reason.trim(), closes_at: fromLocalInput(closes) }), reload))} onCancel={() => setDialog(null)}>
          <p className="confirm-warning">All {c.turnout} {c.turnout === 1 ? 'vote' : 'votes'} will be deleted. Everyone will be able to vote again. This can't be undone.</p>
          <div className="stack">
            <label>Type the campaign title to confirm<span className="field-helper">{c.title}</span>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} /></label>
            <label>Reason<span className="field-helper">At least 10 characters. It is kept in the reset history, visible with the results.</span>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1000} /></label>
            <label>New closing time <span className="field-helper">Optional. Windhoek time (CAT). Needed if the closing time has already passed.</span>
              <input type="datetime-local" value={closes} onChange={(e) => setCloses(e.target.value)} /></label>
          </div>
        </Dialog>
      )}
    </aside>
  );
}

export function CampaignPage() {
  const { id = '' } = useParams();
  const [c, setC] = useState<CampaignDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('candidates');
  const reload = useCallback(async () => {
    try { setC(await api<CampaignDetail>('GET', `/api/campaigns/${id}`)); setError(null); } catch (e) { setError((e as Error).message); }
  }, [id]);
  useEffect(() => { void reload(); }, [reload]);

  if (error && !c) return <><ErrorBox message={error === 'Not found' ? 'Campaign not found.' : error} onRetry={error === 'Not found' ? undefined : () => void reload()} /><Link to="/admin">Back to campaigns</Link></>;
  if (!c) return <Spinner />;

  return (
    <>
      <BackLink to="/admin">Back to campaigns</BackLink>
      <section className="card card-accent head-card">
        <div className="head-inner">
          <div className="initials-box" aria-hidden="true">{initials(c.title)}</div>
          <div className="grow">
            <h1 className="head-title">{c.title}</h1>
            {c.description && <p className="head-desc">{c.description}</p>}
            <div className="meta-row">
              <span className="meta"><Icon name="flag" /> <StatusBadge status={c.status} />{c.archived_at && <span className="chip chip-outline">Archived</span>}{c.allow_edits_after_start && c.status !== 'closed' && <span className="chip chip-outline">Edits allowed after start</span>}</span>
              <span className="meta"><Icon name="calendar" /> Opens {fmtDate(c.opens_at)}</span>
              <span className="meta"><Icon name="clock" /> Closes {fmtDate(c.closes_at)}</span>
            </div>
          </div>
          <div className="id-chip"><div className="field-label">Campaign ID</div><div className="id-value">{c.id.slice(0, 8).toUpperCase()}</div></div>
        </div>
      </section>

      <IntegrityBanner c={c} reload={reload} />
      <NoticeList notices={c.edited_after_start} title="Edited after start" />

      <div className="cols">
        <div className="card card-pad main-col">
          <Tabs<Tab> label="Campaign sections" value={tab} onChange={setTab} tabs={[
            { id: 'candidates', label: 'Candidates', count: c.candidates.length },
            { id: 'eligibility', label: 'Eligibility' },
            { id: 'results', label: 'Results' },
            { id: 'team', label: 'Team' },
          ]}>
            {tab === 'candidates' && <CandidatesTab c={c} reload={reload} />}
            {tab === 'eligibility' && <EligibilityTab c={c} reload={reload} />}
            {tab === 'results' && <ResultsTab c={c} reload={reload} />}
            {tab === 'team' && <TeamTab c={c} reload={reload} />}
          </Tabs>
        </div>
        <SideCard c={c} reload={reload} />
      </div>
    </>
  );
}
