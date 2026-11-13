import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fromLocalInput, type Campaign } from '../../api';
import { EligibilityPicker, parseEmails, type EligMode } from '../../eligibility';
import { BackLink, ErrorBox, PageTitle, SectionTitle } from '../../ui';

/** Step 1: details, voting window and who may vote. Candidates are added on the next screen (the draft needs an id first). */
export function NewCampaign() {
  const nav = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [opens, setOpens] = useState('');
  const [closes, setCloses] = useState('');
  const [eligibility, setEligibility] = useState<EligMode>('umoja');
  const [emailText, setEmailText] = useState('');
  const [allowEdits, setAllowEdits] = useState(false);
  const [allowAbstain, setAllowAbstain] = useState(false);
  const [needApproval, setNeedApproval] = useState(false);
  const [quorum, setQuorum] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const emails = parseEmails(emailText);

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      // The mode chosen here is saved WITH the campaign (it used to be chosen only on the next screen and had to be saved separately).
      const c = await api<Campaign>('POST', '/api/campaigns', {
        title, description: description || null, opens_at: fromLocalInput(opens), closes_at: fromLocalInput(closes),
        eligibility, ...(eligibility === 'list' ? { emails } : {}), allow_edits_after_start: allowEdits, allow_abstain: allowAbstain, require_approval: needApproval, ...(eligibility !== 'all' && quorum ? { quorum_percent: Number(quorum) } : {}),
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
            <label>Opens at <span className="field-helper">Optional. Windhoek time (CAT). Leave empty to open as soon as you start.</span>
              <input type="datetime-local" value={opens} onChange={(e) => setOpens(e.target.value)} /></label>
            <label>Closes at <span className="field-helper">Optional. Windhoek time (CAT). Closes automatically at this time.</span>
              <input type="datetime-local" value={closes} onChange={(e) => setCloses(e.target.value)} /></label>
          </div>
        </section>
        <section className="form-section">
          <SectionTitle icon="lock">Who can vote</SectionTitle>
          <EligibilityPicker mode={eligibility} onMode={setEligibility} text={emailText} onText={setEmailText} />
          <p className="field-helper">This is locked once voting starts.</p>
          <label>Quorum (optional)<span className="field-helper">{eligibility === 'all' ? 'Needs a known list of voters: choose Umoja members or a list of emails.' : 'Minimum turnout, as a percentage of the eligible voters (1 to 100). A result below it is flagged everywhere; it can still be published, but only knowingly. Locked once voting starts.'}</span>
            <input type="number" min={1} max={100} step={1} value={quorum} onChange={(e) => setQuorum(e.target.value)} disabled={eligibility === 'all'} /></label>
        </section>
        <section className="form-section">
          <SectionTitle icon="check">Ballot</SectionTitle>
          <label className="check"><input type="checkbox" checked={allowAbstain} onChange={(e) => setAllowAbstain(e.target.checked)} /> Add an “Abstain (none of the above)” option</label>
          <p className="field-helper">Off by default. When on, voters can choose to abstain. An abstention counts as a vote cast (turnout) but can never win and is reported separately. Locked once voting starts.</p>
        </section>
        <section className="form-section">
          <SectionTitle icon="lock">Safeguards</SectionTitle>
          <label className="check"><input type="checkbox" checked={needApproval} onChange={(e) => setNeedApproval(e.target.checked)} /> Require a co-admin’s approval to reset votes or delete this campaign permanently</label>
          <p className="field-helper">Off by default. When on, add a co-admin on the Team tab. This rule can never be switched off again.</p>
        </section>
        <section className="form-section">
          <SectionTitle icon="info">After voting starts</SectionTitle>
          <label className="check"><input type="checkbox" checked={allowEdits} onChange={(e) => setAllowEdits(e.target.checked)} /> Allow edits after start</label>
          <p className="field-helper">Off by default: starting locks everything. When on, the title, description and closing time can still be edited while voting is open, and candidates can be added, edited or removed until the first vote is cast. Who can vote stays locked. Every edit is recorded and shown as “Edited after start” to you and to voters.</p>
        </section>
        <p className="muted small form-note">Next you will add candidates.</p>
        <ErrorBox message={error} />
        <div className="form-actions">
          <Link className="btn btn-secondary" to="/admin">Cancel</Link>
          <button className="btn btn-primary" disabled={busy || !title.trim() || (eligibility === 'list' && emails.length === 0)}>Create draft</button>
        </div>
      </form>
    </>
  );
}
