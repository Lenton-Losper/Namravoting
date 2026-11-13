import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, fmtDate, type CampaignDetail } from '../../api';
import { ErrorBox, SectionTitle, Spinner } from '../../ui';

export interface TeamMember { oid: string; role: 'co_admin' | 'observer'; name: string; email: string; added_at: string }
export interface ApprovalRow {
  id: string; kind: 'reset' | 'permanent_delete'; status: 'pending' | 'approved' | 'rejected' | 'executed' | 'cancelled'; payload: { reason?: string };
  requested_at: string; decided_at: string | null; decision_note: string | null; executed_at: string | null; requested_by: string; requested_by_name: string; decided_by_name: string | null; executable: boolean;
}
interface Team { owner: { name: string; email: string }; members: TeamMember[]; approvals: ApprovalRow[]; require_approval: boolean; my_role: 'owner' | 'co_admin'; approval_valid_hours: number }

const ROLE = { co_admin: 'Co-admin', observer: 'Observer' };
const KIND = { reset: 'Reset votes', permanent_delete: 'Delete permanently' };

/**
 * Who works on this campaign besides the creator, and the second-approver rule for a reset or a permanent delete.
 * Co-admins can run the campaign; observers can only watch (turnout, the sealed result, the audit trail).
 */
export function TeamTab({ c, reload }: { c: CampaignDetail; reload: () => Promise<void> }) {
  const owner = c.my_role !== 'co_admin';
  const [t, setT] = useState<Team | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'co_admin' | 'observer'>('observer');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api<Team>('GET', `/api/campaigns/${c.id}/team`).then((x) => { setT(x); setError(null); }).catch((e: Error) => setError(e.message)); }, [c.id]);
  useEffect(load, [load]);

  async function act(fn: () => Promise<unknown>, after?: () => Promise<void>) {
    setBusy(true); setError(null);
    try { await fn(); load(); if (after) await after(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function add(e: FormEvent) {
    e.preventDefault();
    await act(() => api('POST', `/api/campaigns/${c.id}/team`, { email: email.trim(), role }), async () => setEmail(''));
  }
  const base = `/api/campaigns/${c.id}`;

  if (!t) return error ? <ErrorBox message={error} onRetry={load} /> : <Spinner />;
  return (
    <>
      <SectionTitle icon="users">Team</SectionTitle>
      <ul className="list">
        <li><strong>{t.owner.name}</strong> <span className="muted small">{t.owner.email} · owner</span></li>
        {t.members.map((m) => (
          <li key={m.oid} className="row-between">
            <span><strong>{m.name}</strong> <span className="muted small">{m.email} · {ROLE[m.role]}</span></span>
            {owner && <button className="btn btn-secondary btn-sm" disabled={busy} aria-label={`Remove ${m.name}`} onClick={() => void act(() => api('DELETE', `${base}/team/${m.oid}`))}>Remove</button>}
          </li>
        ))}
      </ul>
      <p className="field-helper"><strong>Co-admins</strong> can run the campaign (edit, start, close, publish, export) but not reset, delete, archive or change the team. <strong>Observers</strong> can only watch: turnout, the sealed result once closed, and the audit trail, never live counts.</p>
      {owner && (
        <form onSubmit={(e) => void add(e)} className="stack">
          <label>Email<span className="field-helper">They must have signed in to NamRA Voting once. A co-admin must already be a campaign administrator.</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} /></label>
          <label>Role
            <select value={role} onChange={(e) => setRole(e.target.value as 'co_admin' | 'observer')}>
              <option value="observer">Observer (read-only)</option><option value="co_admin">Co-admin (can run it)</option>
            </select></label>
          <div className="form-actions"><button className="btn btn-secondary" disabled={busy || !email.trim()}>Add to team</button></div>
        </form>
      )}

      <SectionTitle icon="lock">Second approver</SectionTitle>
      {t.require_approval
        ? <p>On. Resetting votes or deleting this campaign permanently needs a co-admin&rsquo;s approval. The rule cannot be switched off.</p>
        : (
          <>
            <p className="field-helper">When on, resetting votes or deleting the campaign permanently needs the approval of a co-admin (a second person) and then the creator carries it out. It can be switched on, never off.</p>
            {owner && <button className="btn btn-secondary" disabled={busy} onClick={() => void act(() => api('PUT', `${base}/approval-policy`, { require_approval: true }), reload)}>Require a second approver</button>}
          </>
        )}
      {t.approvals.length > 0 && (
        <ul className="list approvals">
          {t.approvals.map((a) => (
            <li key={a.id} className="card card-pad">
              <strong>{KIND[a.kind]}</strong> · {a.status} <span className="muted small">requested by {a.requested_by_name} {fmtDate(a.requested_at)}</span>
              {a.payload.reason && <div className="muted small">Reason: {a.payload.reason}</div>}
              {a.decided_by_name && <div className="muted small">{a.status === 'rejected' ? 'Rejected' : 'Approved'} by {a.decided_by_name} {fmtDate(a.decided_at)}{a.decision_note ? `: ${a.decision_note}` : ''}</div>}
              <div className="form-actions">
                {!owner && a.status === 'pending' && (
                  <>
                    <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => void act(() => api('POST', `${base}/approvals/${a.id}/approve`, {}))}>Approve</button>
                    <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void act(() => api('POST', `${base}/approvals/${a.id}/reject`, {}))}>Reject</button>
                  </>
                )}
                {owner && a.status === 'approved' && a.executable && (
                  <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void act(() => api('POST', `${base}/approvals/${a.id}/execute`), a.kind === 'permanent_delete' ? async () => { window.location.assign('/admin'); } : reload)}>Carry it out now</button>
                )}
                {owner && a.status === 'approved' && !a.executable && <span className="muted small">Approval older than {t.approval_valid_hours} hours: cancel and ask again.</span>}
                {owner && (a.status === 'pending' || a.status === 'approved') && (
                  <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void act(() => api('POST', `${base}/approvals/${a.id}/cancel`, {}))}>Cancel request</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <ErrorBox message={error} />
    </>
  );
}
