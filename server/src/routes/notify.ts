import { Router, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { getConfig } from '../config.js';
import { getPool } from '../db.js';
import { HttpError } from '../errors.js';
import { currentUser } from '../auth/index.js';
import { audit } from '../services/audit.js';
import type { CampaignRow } from '../services/campaigns.js';
import { audienceFor, BATCH, composeMessage, getMailer, MailRejected, type NoticeKind } from '../services/notify.js';

/** Staff notifications (business-logic item 7). The creator or a co-admin; open campaigns only. See services/notify.ts for the privacy rules. */

const KINDS: NoticeKind[] = ['open', 'reminder', 'closing_soon'];
const body = z.object({ kind: z.enum(['open', 'reminder', 'closing_soon']) }).strict();
/** The same notice is not sent twice within this time (a double click, or someone nagging staff). */
export const MIN_INTERVAL_MINUTES = 60;

export function notifyRouter(d: { loadRunnable: RequestHandler; camp: (res: Response) => CampaignRow }): Router {
  const r = Router({ mergeParams: true });

  const lastSent = async (id: string) => {
    const { rows } = await getPool().query("SELECT details->>'kind' AS kind, max(at) AS at FROM audit_log WHERE campaign_id = $1 AND action = 'notify.sent' GROUP BY 1", [id]);
    return Object.fromEntries(KINDS.map((k) => [k, rows.find((x) => x.kind === k)?.at ?? null]));
  };

  r.get('/notify', d.loadRunnable, async (_req, res) => {
    const c = d.camp(res);
    const a = await audienceFor(getPool(), c);
    // Counts only. Who has not voted is not shown to anyone.
    res.set('Cache-Control', 'no-store').json({
      configured: getMailer() !== null, open: c.status === 'open', mailable: a.mailable, total: a.total, reachable: a.reachable, unreachable: a.unreachable,
      not_voted: a.mailable ? a.pending.length : null, last_sent: await lastSent(c.id), min_interval_minutes: MIN_INTERVAL_MINUTES,
    });
  });

  r.post('/notify', d.loadRunnable, async (req, res) => {
    const c = d.camp(res); const u = currentUser(req);
    const { kind } = body.parse(req.body);
    const mailer = getMailer();
    if (!mailer) throw new HttpError(409, 'Email is not set up. IT must grant the app the Mail.Send permission and the sender mailbox must be set (NOTIFY_SENDER).', 'not_configured');
    if (c.status !== 'open') throw new HttpError(409, 'Notices can only be sent while voting is open', 'not_open');
    if (kind === 'closing_soon' && !c.closes_at) throw new HttpError(409, 'This campaign has no closing time to announce', 'no_closing_time');
    const a = await audienceFor(getPool(), c);
    if (!a.mailable) throw new HttpError(409, 'A vote open to all staff has no list of people to write to. Share the link or the QR code instead, or use a listed vote.', 'not_mailable');
    const to = kind === 'open' ? a.all : a.pending;
    if (!to.length) throw new HttpError(409, kind === 'open' ? 'There is no one with a known email address to write to' : 'Everyone who can be reached has already voted', 'nobody_to_notify');
    const recent = await getPool().query("SELECT 1 FROM audit_log WHERE campaign_id = $1 AND action = 'notify.sent' AND details->>'kind' = $2 AND at > now() - make_interval(mins => $3)", [c.id, kind, MIN_INTERVAL_MINUTES]);
    if (recent.rowCount) throw new HttpError(409, `This notice was sent less than ${MIN_INTERVAL_MINUTES} minutes ago`, 'too_soon');
    const msg = composeMessage(kind, { title: c.title, description: c.description, share_url: `${getConfig().publicBaseUrl}/v/${c.share_token}`, closes_at: c.closes_at }, new Date());
    let sent = 0;
    try {
      for (let i = 0; i < to.length; i += BATCH) { const batch = to.slice(i, i + BATCH); await mailer.send(batch, msg.subject, msg.text); sent += batch.length; }
    } catch (e) {
      await audit(getPool(), u.oid, 'notify.failed', c.id, { kind, recipients_before_failure: sent, error: (e as Error).message.slice(0, 200) });
      if (e instanceof MailRejected) throw new HttpError(502, e.message, e.permission ? 'mail_denied' : 'mail_failed');
      throw e;
    }
    await audit(getPool(), u.oid, 'notify.sent', c.id, { kind, recipients: sent, unreachable: a.unreachable });   // counts only: nobody is named
    res.json({ sent, unreachable: a.unreachable });
  });

  return r;
}
