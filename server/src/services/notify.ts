import type { Queryable } from '../db.js';
import { getConfig } from '../config.js';
import { fmtWindhoek } from './resultsExport.js';

/**
 * Notifying staff (business-logic item 7): an email when voting opens, a reminder to eligible people who have not voted yet, and a
 * closing-soon notice. Sent through Microsoft Graph (application permission Mail.Send, which IT must grant) from the mailbox in
 * NOTIFY_SENDER. Without NOTIFY_SENDER nothing can be sent and the screen says so.
 *
 * PRIVACY: the system knows who has a receipt (that is how "one vote each" works), but nobody else does. Reminders go out as ONE message per
 * batch with every recipient in BCC, so no recipient sees who else was reminded, and the creator sees only a COUNT. Nothing here records
 * who was reminded (the audit entry holds counts only).
 */

export type NoticeKind = 'open' | 'reminder' | 'closing_soon';

export interface Mailer { send(bcc: string[], subject: string, text: string): Promise<void> }

export class MailRejected extends Error {
  constructor(message: string, public readonly permission: boolean) { super(message); }
}

export interface GraphMailerOptions {
  tenantId: string; clientId: string; clientSecret: string; sender: string;
  fetchImpl?: typeof fetch; authority?: string; graphBase?: string; now?: () => number;
}

export function createGraphMailer(o: GraphMailerOptions): Mailer {
  const f = o.fetchImpl ?? fetch;
  const authority = (o.authority ?? 'https://login.microsoftonline.com').replace(/\/$/, '');
  const graph = (o.graphBase ?? 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
  const now = o.now ?? Date.now;
  let token: { value: string; until: number } | undefined;

  async function accessToken(): Promise<string> {
    if (token && token.until > now() + 60_000) return token.value;
    const r = await f(`${authority}/${o.tenantId}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' }),
    });
    const j = (await r.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_codes?: number[] };
    if (!r.ok || !j.access_token) throw new MailRejected(`Microsoft refused the mail sign-in${j.error_codes?.length ? ` (AADSTS${j.error_codes[0]})` : ''}`, false);
    token = { value: j.access_token, until: now() + (j.expires_in ?? 3000) * 1000 };
    return token.value;
  }

  return {
    async send(bcc, subject, text) {
      const r = await f(`${graph}/users/${encodeURIComponent(o.sender)}/sendMail`, {
        method: 'POST', headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: { subject, body: { contentType: 'Text', content: text }, toRecipients: [{ emailAddress: { address: o.sender } }], bccRecipients: bcc.map((address) => ({ emailAddress: { address } })) },
          saveToSentItems: false,
        }),
      });
      if (r.status === 202 || r.ok) return;
      if (r.status === 401 || r.status === 403) throw new MailRejected('Microsoft refused to send the mail: the app needs the Mail.Send permission (ask IT to grant it).', true);
      throw new MailRejected(`Microsoft could not send the mail (HTTP ${r.status}).`, false);
    },
  };
}

/** Test seam: a test puts a fake mailer here. Empty in production. */
export const notifyHooks: { mailer?: Mailer | null } = {};

export function getMailer(): Mailer | null {
  if (notifyHooks.mailer !== undefined) return notifyHooks.mailer;
  const c = getConfig();
  if (!c.entra || !c.notifySender) return null;
  return createGraphMailer({ tenantId: c.entra.tenantId, clientId: c.entra.clientId, clientSecret: c.entra.clientSecret, sender: c.notifySender });
}

export const BATCH = 100;

export interface Audience { mailable: boolean; total: number; reachable: number; pending: string[]; all: string[]; unreachable: number }

/**
 * Who could be emailed. Only for a vote with a voter list (a listed vote, or the Umoja snapshot): a vote open to "all staff" has no list of
 * people to write to. `pending` are the reachable people WITHOUT a receipt; the caller must treat it as sensitive (counts only).
 */
export async function audienceFor(db: Queryable, c: { id: string; eligibility: 'all' | 'list' | 'umoja' }): Promise<Audience> {
  if (c.eligibility === 'all') return { mailable: false, total: 0, reachable: 0, pending: [], all: [], unreachable: 0 };
  const rows = c.eligibility === 'list'
    ? (await db.query(
      `SELECT e.voter_email AS email, EXISTS (SELECT 1 FROM users u JOIN vote_receipts r ON r.voter_oid = u.entra_oid AND r.campaign_id = $1 WHERE u.email = e.voter_email) AS voted
         FROM eligible_voters e WHERE e.campaign_id = $1`, [c.id])).rows
    : (await db.query(
      `SELECT u.email, EXISTS (SELECT 1 FROM vote_receipts r WHERE r.campaign_id = $1 AND (r.voter_oid = v.entra_oid OR r.member_key = 'code:' || v.member_code OR r.voter_oid IN (SELECT y.entra_oid FROM users y WHERE y.employee_code = v.member_code))) AS voted
         FROM campaign_voters v
         LEFT JOIN LATERAL (SELECT x.email FROM users x WHERE (x.entra_oid = v.entra_oid OR x.employee_code = v.member_code) AND x.email NOT LIKE '%@removed.invalid'
                             ORDER BY (x.entra_oid = v.entra_oid) DESC LIMIT 1) u ON true
        WHERE v.campaign_id = $1 AND v.active`, [c.id])).rows;
  const reachable = rows.filter((r) => r.email) as { email: string; voted: boolean }[];
  return {
    mailable: true, total: rows.length, reachable: reachable.length, unreachable: rows.length - reachable.length,
    all: reachable.map((r) => r.email), pending: reachable.filter((r) => !r.voted).map((r) => r.email),
  };
}

export function composeMessage(kind: NoticeKind, c: { title: string; description: string | null; share_url: string; closes_at: Date | null }, now = new Date()): { subject: string; text: string } {
  const closes = c.closes_at ? fmtWindhoek(c.closes_at) : null;
  const hoursLeft = c.closes_at ? Math.max(0, Math.round((c.closes_at.getTime() - now.getTime()) / 3_600_000)) : null;
  const how = `Vote here: ${c.share_url}\nSign in with your NamRA account. Your vote is secret, you can vote once, and it cannot be changed.`;
  const sign = '\nNamRA Voting';
  if (kind === 'open') {
    return { subject: `Voting is open: ${c.title}`, text: `Voting is now open for "${c.title}".${c.description ? `\n\n${c.description}` : ''}\n\n${how}${closes ? `\nVoting closes ${closes} (Windhoek time).` : ''}\n${sign}` };
  }
  if (kind === 'reminder') {
    return { subject: `Reminder: please vote in ${c.title}`, text: `This is a reminder to vote in "${c.title}". You are receiving it because you are eligible; if you have already voted, please ignore it.\n\n${how}${closes ? `\nVoting closes ${closes} (Windhoek time).` : ''}\n${sign}` };
  }
  return { subject: `Closing soon: ${c.title}`, text: `Voting in "${c.title}" closes ${closes ?? 'soon'} (Windhoek time)${hoursLeft !== null ? `, in about ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'}` : ''}. If you have not voted yet, please do so now; if you already have, please ignore this.\n\n${how}\n${sign}` };
}
