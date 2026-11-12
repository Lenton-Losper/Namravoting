import { useId } from 'react';

export type EligMode = 'umoja' | 'all' | 'list';

export const parseEmails = (raw: string) => [...new Set(raw.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean))];

/**
 * Who may vote. Used when creating a campaign and when editing a draft, so both screens offer the same choices and the same wording.
 * It only shows and reports the choice; whoever uses it is responsible for SAVING it (the create form sends it with the campaign).
 */
export function EligibilityPicker({ mode, onMode, text, onText, umojaCount }: {
  mode: EligMode; onMode: (m: EligMode) => void; text: string; onText: (t: string) => void; umojaCount?: number;
}) {
  const name = useId();
  const emails = parseEmails(text);
  return (
    <div className="stack">
      <label className="check"><input type="radio" name={name} checked={mode === 'umoja'} onChange={() => onMode('umoja')} /> Umoja members only{umojaCount !== undefined ? ` (${umojaCount} active member${umojaCount === 1 ? '' : 's'})` : ''}</label>
      <label className="check"><input type="radio" name={name} checked={mode === 'all'} onChange={() => onMode('all')} /> All signed-in NamRA staff</label>
      <label className="check"><input type="radio" name={name} checked={mode === 'list'} onChange={() => onMode('list')} /> Only these email addresses</label>
      {mode === 'list' && (
        <label>Email addresses<span className="field-helper">One per line, or separated by commas. {emails.length} address{emails.length === 1 ? '' : 'es'}.</span>
          <textarea rows={6} value={text} onChange={(e) => onText(e.target.value)} /></label>
      )}
    </div>
  );
}
