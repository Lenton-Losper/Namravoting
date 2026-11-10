import { useRef, useState } from 'react';
import { Icon } from './icons';
import { Dialog } from './ui';

export interface Shareable { id: string; title: string; share_url: string; status: 'draft' | 'open' | 'closed' }

/**
 * Link + QR + poster + system share + WhatsApp. Used by the dashboard Share dialog and the detail page side card.
 * The link and QR carry only the campaign's random share token; every access check happens on the server after the scan.
 */
export function SharePanel({ c, compact = false }: { c: Shareable; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = c.status === 'open';

  async function copy(): Promise<boolean> {
    setError(null);
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(c.share_url);
      else { input.current?.select(); if (!document.execCommand('copy')) throw new Error('copy failed'); }   // non-secure-context fallback
      setCopied(true); setTimeout(() => setCopied(false), 2000);
      return true;
    } catch {
      input.current?.select();
      setError('Could not copy automatically. The link is selected: copy it manually.');
      return false;
    }
  }

  async function share() {
    if (typeof navigator.share === 'function') {
      try { await navigator.share({ title: c.title, text: `Vote in ${c.title}`, url: c.share_url }); }
      catch (e) { if ((e as DOMException).name !== 'AbortError') await copy(); }   // user cancelling is not an error
    } else {
      await copy();                                                                  // no Web Share API: fall back to copy
    }
  }

  const whatsapp = `https://wa.me/?text=${encodeURIComponent(`Vote in ${c.title}: ${c.share_url}`)}`;

  return (
    <div className="share-panel">
      <label>Voting link
        <span className="field-helper">Share this with staff.</span>
        <input ref={input} readOnly value={c.share_url} onFocus={(e) => e.currentTarget.select()} />
      </label>
      <div className="share-row">
        <button className="btn btn-primary" onClick={() => void copy()}>
          <Icon name={copied ? 'check' : 'copy'} /> {copied ? 'Copied' : 'Copy link'}
        </button>
        {open && <button className="btn btn-secondary" onClick={() => void share()}><Icon name="share" /> Share…</button>}
        {open && <a className="btn btn-secondary" href={whatsapp} target="_blank" rel="noopener noreferrer">Share on WhatsApp</a>}
      </div>
      <span className="sr-only" role="status">{copied ? 'Link copied' : ''}</span>
      {error && <p className="error" role="alert">{error}</p>}
      {open && (
        <>
          <img className={compact ? 'qr' : 'qr qr-large'} src={`/api/campaigns/${c.id}/qr.png`} alt="QR code for the voting link"
            width={compact ? 160 : 240} height={compact ? 160 : 240} />
          <div className="share-row share-row-center">
            <a className="btn btn-secondary" href={`/api/campaigns/${c.id}/qr.png?download=1`} download="voting-qr.png"><Icon name="download" /> Download QR (PNG)</a>
            <a className="btn btn-secondary" href={`/api/campaigns/${c.id}/poster.pdf`} download><Icon name="download" /> Download poster (PDF)</a>
          </div>
        </>
      )}
      <p className="field-helper">Only staff signed in with their NamRA account can vote. Each person can vote once.</p>
    </div>
  );
}

export function ShareDialog({ c, onClose }: { c: Shareable; onClose: () => void }) {
  return (
    <Dialog title={`Share “${c.title}”`} className="sheet-wide" hideConfirm cancelLabel="Close" confirmLabel="" onConfirm={onClose} onCancel={onClose}>
      <SharePanel c={c} />
    </Dialog>
  );
}
