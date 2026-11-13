import { useCallback, useEffect, useState } from 'react';
import { api, fmtDate, type CampaignDetail } from '../../api';
import { Dialog, ErrorBox, SectionTitle } from '../../ui';

interface Info {
  configured: boolean; open: boolean; mailable: boolean; total: number; reachable: number; unreachable: number; not_voted: number | null;
  last_sent: Record<'open' | 'reminder' | 'closing_soon', string | null>; min_interval_minutes: number;
}
type Kind = 'open' | 'reminder' | 'closing_soon';

const LABEL: Record<Kind, string> = { open: 'Send “voting is open”', reminder: 'Remind people who have not voted', closing_soon: 'Send “closing soon”' };
const WHO: Record<Kind, string> = { open: 'everyone with a known email address', reminder: 'the people who have not voted yet', closing_soon: 'the people who have not voted yet' };

/**
 * Email staff while voting is open. The system knows who has voted (that is how "one vote each" works) but nobody else does: reminders
 * go out in BCC and you only ever see counts here, never names.
 */
export function NotifyPanel({ c }: { c: CampaignDetail }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Kind | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const load = useCallback(() => { api<Info>('GET', `/api/campaigns/${c.id}/notify`).then(setInfo).catch((e: Error) => setError(e.message)); }, [c.id]);
  useEffect(load, [load, c.turnout]);

  async function send(kind: Kind) {
    setBusy(true); setError(null); setDone(null);
    try {
      const r = await api<{ sent: number; unreachable: number }>('POST', `/api/campaigns/${c.id}/notify`, { kind });
      setDone(`Sent to ${r.sent} ${r.sent === 1 ? 'person' : 'people'}.`); load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); setConfirm(null); }
  }

  if (c.status !== 'open') return null;
  const count = (k: Kind) => (k === 'open' ? info?.reachable : info?.not_voted) ?? 0;
  const kinds: Kind[] = c.closes_at ? ['open', 'reminder', 'closing_soon'] : ['open', 'reminder'];
  return (
    <div className="notify-panel">
      <SectionTitle icon="share">Email staff</SectionTitle>
      {!info && !error && <p className="muted small">Checking…</p>}
      {info && !info.configured && <p className="field-helper" role="note">Email is not set up yet. IT must give the app the Microsoft Graph “Mail.Send” permission and the sender mailbox must be set (NOTIFY_SENDER). Until then, share the link or the QR code.</p>}
      {info && info.configured && !info.mailable && <p className="field-helper" role="note">A vote open to all staff has no list of people to write to. Share the link or the QR code instead, or use a listed vote.</p>}
      {info && info.configured && info.mailable && (
        <>
          <p className="field-helper">{info.reachable} of {info.total} voters have a known email address{info.unreachable > 0 ? ` (${info.unreachable} cannot be reached by email)` : ''}. {info.not_voted} of them {info.not_voted === 1 ? 'has' : 'have'} not voted yet. Emails are sent in BCC: nobody sees who else received one, and you never see who has voted.</p>
          <div className="stack">
            {kinds.map((k) => (
              <button key={k} className="btn btn-secondary" disabled={busy || count(k) === 0} onClick={() => setConfirm(k)}>
                {LABEL[k]}{info.last_sent[k] ? ` (last sent ${fmtDate(info.last_sent[k])})` : ''}
              </button>
            ))}
          </div>
        </>
      )}
      {done && <p className="ok" role="status">{done}</p>}
      <ErrorBox message={error} />
      {confirm && (
        <Dialog title={`${LABEL[confirm]}?`} confirmLabel={`Send to ${count(confirm)}`} busy={busy} onConfirm={() => void send(confirm)} onCancel={() => setConfirm(null)}>
          <p>This emails {WHO[confirm]} ({count(confirm)} {count(confirm) === 1 ? 'person' : 'people'}) with the link to vote. The same notice cannot be sent again for {info?.min_interval_minutes ?? 60} minutes.</p>
        </Dialog>
      )}
    </div>
  );
}
