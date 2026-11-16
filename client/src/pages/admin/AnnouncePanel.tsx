import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, type AnnouncePreview, type CampaignDetail } from '../../api';
import { Icon } from '../../icons';
import { Dialog, ErrorBox, Spinner } from '../../ui';

/**
 * "Announce winners" (replaces "Publish results"). Voters never see results, counts or turnout. After the close the creator or a co-admin announces
 * the WINNERS by name, once; it is shown only to people who voted. Blocked while a position is tied ("Tied: create a run-off") or when the result no
 * longer matches its seal. "Copy announcement text" gives the same text for WhatsApp or Teams.
 */
export function AnnouncePanel({ c, reload }: { c: CampaignDetail; reload: () => Promise<void> }) {
  const [pv, setPv] = useState<AnnouncePreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [askBelow, setAskBelow] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const load = useCallback(async () => {
    try { setPv(await api<AnnouncePreview>('GET', `/api/campaigns/${c.id}/announcement`)); setError(null); } catch (e) { setError((e as Error).message); }
  }, [c.id]);
  useEffect(() => { void load(); }, [load]);

  async function announce(acknowledge = false) {
    setBusy(true); setError(null);
    try { await api('POST', `/api/campaigns/${c.id}/announce-winners`, acknowledge ? { acknowledge_below_quorum: true } : {}); setAskBelow(false); setConfirm(false); await load(); await reload(); }
    catch (e) { setError((e as Error).message); setAskBelow(false); setConfirm(false); await load(); } finally { setBusy(false); }
  }
  async function copy() {
    if (!pv?.text) return;
    try { await navigator.clipboard.writeText(pv.text); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setError('Copy failed: select the text and copy it by hand.'); }
  }

  if (!pv) return error ? <ErrorBox message={error} onRetry={() => void load()} /> : <Spinner />;
  if (!Array.isArray(pv.positions)) return null;   // not an announcement preview (nothing to show)
  const tied = pv.blocks.find((b) => b.code === 'tied');
  const others = pv.blocks.filter((b) => b.code !== 'tied' && b.code !== 'already_announced');
  const blocked = pv.blocks.length > 0;
  return (
    <section className="announce-panel" aria-label="Announce winners">
      <h3 className="announce-title">Announce winners</h3>
      <p className="field-helper">Voters never see results or counts. Announce the winners by name to everyone who voted: it appears on their campaign page and My votes. Names only, no numbers. It can be done once.</p>

      <ul className="announce-winners" aria-label="Winners">
        {pv.positions.map((p) => (
          <li key={p.id}>
            <strong>{p.title}</strong>
            {p.tie
              ? <span className="chip-status chip-problem"><Icon name="alert" size={14} /> Tied: {p.tie.join(' and ')}</span>
              : <span>{p.winners.length ? p.winners.join(', ') : 'No winner (no votes were cast)'}</span>}
          </li>
        ))}
      </ul>

      {tied && <p className="announce-block" role="alert"><Icon name="alert" size={16} /> <span>{tied.message}{tied.positions?.length ? ` (${tied.positions.join(', ')})` : ''}. A tie has no winner to announce.</span></p>}
      {others.map((b) => <p key={b.code} className="announce-block" role="alert"><Icon name="alert" size={16} /> <span>{b.message}</span></p>)}

      {pv.announced
        ? <p className="announce-done" role="status"><span className="chip-status chip-ready"><span aria-hidden="true">✓</span> Announced</span> {pv.announced.by ?? 'An administrator'} announced the winners on {fmtDate(pv.announced.at)}.</p>
        : (
          <div className="announce-actions">
            <button type="button" className="btn btn-primary btn-44" disabled={blocked || busy} onClick={() => (pv.below_quorum ? setAskBelow(true) : setConfirm(true))}>Announce winners</button>
            <button type="button" className="btn btn-secondary btn-44" disabled={!pv.text} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy announcement text'}</button>
          </div>
        )}
      {pv.announced && <div className="announce-actions"><button type="button" className="btn btn-secondary btn-44" disabled={!pv.text} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy announcement text'}</button></div>}
      <p className="field-helper">The copied text can be pasted into WhatsApp or Teams. It lists the winners only.</p>

      <label className="check announce-email">
        <input type="checkbox" disabled aria-describedby="announce-email-why" /> Also email everyone who voted
      </label>
      <p id="announce-email-why" className="field-helper">{pv.email.reason}</p>

      <ErrorBox message={error} />

      {confirm && (
        <Dialog title="Announce the winners?" confirmLabel="Announce winners" busy={busy} onConfirm={() => void announce()} onCancel={() => setConfirm(false)}>
          <p>The winners will be shown to everyone who voted. This can only be done once and cannot be undone.</p>
          <pre className="announce-preview">{pv.text}</pre>
        </Dialog>
      )}
      {askBelow && pv.below_quorum && (
        <Dialog title="Announce below the quorum?" confirmLabel="Announce anyway" danger busy={busy} onConfirm={() => void announce(true)} onCancel={() => setAskBelow(false)}>
          <p>Only {pv.below_quorum.votes} of the {pv.below_quorum.needed ?? '?'} votes needed for the {pv.below_quorum.percent}% quorum were cast. Announce only if that is acceptable under your rules.</p>
          <pre className="announce-preview">{pv.text}</pre>
        </Dialog>
      )}
    </section>
  );
}
