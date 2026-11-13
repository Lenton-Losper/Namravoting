// Business-logic item 7: email at open, a reminder to people who have not voted, a closing-soon notice. Counts only; BCC; no one is named.
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { closePool } from '../../src/db.js';
import { composeMessage, createGraphMailer, MailRejected, notifyHooks, type Mailer } from '../../src/services/notify.js';
import { ADMIN_A, ADMIN_B, S1, S2, S3, closeOwner, login, makeCampaign, ownerDb, resetDb, setMembers } from '../helpers.js';

const app = createApp();
beforeEach(resetDb);
afterEach(() => { notifyHooks.mailer = undefined; });
afterAll(async () => { await closePool(); await closeOwner(); });

type Admin = Awaited<ReturnType<typeof login>>;
interface Sent { bcc: string[]; subject: string; text: string }
const fakeMailer = (log: Sent[], fail?: Error): Mailer => ({ send: async (bcc, subject, text) => { if (fail) throw fail; log.push({ bcc, subject, text }); } });

/** An open listed vote for the given emails (extra addresses have never signed in). */
async function listed(admin: Admin, emails: string[], extra: Record<string, unknown> = {}) {
  const c = (await admin.post('/api/campaigns').send({ title: 'Staff survey', eligibility: 'list', emails, ...extra }).expect(201)).body;
  const cands: string[] = [];
  for (const n of ['One', 'Two']) cands.push((await admin.post(`/api/campaigns/${c.id}/candidates`).field('name', n).expect(201)).body.id);
  await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
  return { id: c.id as string, token: c.share_token as string, cands };
}
const GHOST = 'ghost@namra.test';
const future = () => new Date(Date.now() + 5 * 3600_000).toISOString();

describe('when email is not set up', () => {
  it('says so, and refuses to send', async () => {
    const admin = await login(app, ADMIN_A);
    const c = await listed(admin, [S1.email]);
    expect((await admin.get(`/api/campaigns/${c.id}/notify`).expect(200)).body).toMatchObject({ configured: false, open: true, mailable: true, total: 1 });
    const r = await admin.post(`/api/campaigns/${c.id}/notify`).send({ kind: 'open' }).expect(409);
    expect(r.body.code).toBe('not_configured');
  });
});

describe('sending', () => {
  it('"open" writes to everyone with a known address, in BCC, and records only a count', async () => {
    const log: Sent[] = []; notifyHooks.mailer = fakeMailer(log);
    const admin = await login(app, ADMIN_A);
    await login(app, S1);
    const c = await listed(admin, [S1.email, S2.email, GHOST], { closes_at: future() });
    expect((await admin.post(`/api/campaigns/${c.id}/notify`).send({ kind: 'open' }).expect(200)).body).toEqual({ sent: 3, unreachable: 0 });
    expect(log).toHaveLength(1);
    expect(log[0].bcc.sort()).toEqual([GHOST, S1.email, S2.email].sort());
    expect(log[0].subject).toBe('Voting is open: Staff survey');
    expect(log[0].text).toContain(`/v/${c.token}`); expect(log[0].text).toMatch(/closes \d{2} \w{3} \d{4}, \d{2}:\d{2} CAT/);
    const a = (await ownerDb().query("SELECT details, actor_oid FROM audit_log WHERE campaign_id = $1 AND action = 'notify.sent'", [c.id])).rows;
    expect(a).toHaveLength(1); expect(a[0].details).toEqual({ kind: 'open', recipients: 3, unreachable: 0 }); expect(a[0].actor_oid).toBe(ADMIN_A.oid);
    expect(JSON.stringify(a)).not.toContain('@');                                   // nobody is named in the audit log
  });

  it('a reminder goes only to people without a receipt, and the creator sees only counts', async () => {
    const log: Sent[] = []; notifyHooks.mailer = fakeMailer(log);
    const admin = await login(app, ADMIN_A);
    const c = await listed(admin, [S1.email, S2.email, S3.email, GHOST]);
    await (await login(app, S1)).post(`/api/vote/${c.token}`).send({ candidateId: c.cands[0] }).expect(201);
    await (await login(app, S2)).post(`/api/vote/${c.token}`).send({ candidateId: c.cands[1] }).expect(201);
    const info = (await admin.get(`/api/campaigns/${c.id}/notify`).expect(200)).body;
    expect(info).toMatchObject({ total: 4, reachable: 4, not_voted: 2 });
    expect(Object.keys(info).sort()).toEqual(['configured', 'last_sent', 'mailable', 'min_interval_minutes', 'not_voted', 'open', 'reachable', 'total', 'unreachable']);   // no addresses, no names
    expect((await admin.post(`/api/campaigns/${c.id}/notify`).send({ kind: 'reminder' }).expect(200)).body).toEqual({ sent: 2, unreachable: 0 });
    expect(log[0].bcc.sort()).toEqual([GHOST, S3.email].sort());
    expect(log[0].text).toContain('if you have already voted, please ignore it');
    expect(log[0].text).not.toContain(S1.displayName);
  });

  it('the same notice is not sent twice within the hour', async () => {
    const log: Sent[] = []; notifyHooks.mailer = fakeMailer(log);
    const admin = await login(app, ADMIN_A);
    const c = await listed(admin, [S1.email, S2.email]);
    await admin.post(`/api/campaigns/${c.id}/notify`).send({ kind: 'reminder' }).expect(200);
    expect((await admin.post(`/api/campaigns/${c.id}/notify`).send({ kind: 'reminder' }).expect(409)).body.code).toBe('too_soon');
    await admin.post(`/api/campaigns/${c.id}/notify`).send({ kind: 'open' }).expect(200);      // a different kind is fine
    expect(log).toHaveLength(2);
    expect((await admin.get(`/api/campaigns/${c.id}/notify`)).body.last_sent.reminder).toBeTruthy();
  });

  it('closing-soon needs a closing time; with none left to remind it says so', async () => {
    const log: Sent[] = []; notifyHooks.mailer = fakeMailer(log);
    const admin = await login(app, ADMIN_A);
    const noTime = await listed(admin, [S1.email]);
    expect((await admin.post(`/api/campaigns/${noTime.id}/notify`).send({ kind: 'closing_soon' }).expect(409)).body.code).toBe('no_closing_time');
    const c = await listed(admin, [S1.email], { closes_at: future() });
    await (await login(app, S1)).post(`/api/vote/${c.token}`).send({ candidateId: c.cands[0] }).expect(201);
    expect((await admin.post(`/api/campaigns/${c.id}/notify`).send({ kind: 'closing_soon' }).expect(409)).body.code).toBe('nobody_to_notify');
    expect(log).toHaveLength(0);
  });

  it('large lists go out in batches of 100', async () => {
    const log: Sent[] = []; notifyHooks.mailer = fakeMailer(log);
    const admin = await login(app, ADMIN_A);
    const emails = Array.from({ length: 250 }, (_, i) => `person${i}@namra.test`);
    const c = await listed(admin, emails);
    expect((await admin.post(`/api/campaigns/${c.id}/notify`).send({ kind: 'open' }).expect(200)).body.sent).toBe(250);
    expect(log.map((l) => l.bcc.length)).toEqual([100, 100, 50]);
  });

  it('a vote open to all staff has no list to write to; a closed or draft campaign cannot send', async () => {
    notifyHooks.mailer = fakeMailer([]);
    const admin = await login(app, ADMIN_A);
    const all = await makeCampaign(admin, 2, 'All staff', 'all');
    await admin.post(`/api/campaigns/${all.id}/start`).expect(200);
    expect((await admin.get(`/api/campaigns/${all.id}/notify`)).body).toMatchObject({ mailable: false, not_voted: null });
    expect((await admin.post(`/api/campaigns/${all.id}/notify`).send({ kind: 'open' }).expect(409)).body.code).toBe('not_mailable');
    const c = await listed(admin, [S1.email]);
    await admin.post(`/api/campaigns/${c.id}/close`).send({}).expect(200);
    expect((await admin.post(`/api/campaigns/${c.id}/notify`).send({ kind: 'open' }).expect(409)).body.code).toBe('not_open');
    await admin.post(`/api/campaigns/${c.id}/notify`).send({ kind: 'bogus' }).expect(400);
  });

  it('a mail failure is reported plainly, audited, and nothing is recorded as sent', async () => {
    notifyHooks.mailer = fakeMailer([], new MailRejected('Microsoft refused to send the mail: the app needs the Mail.Send permission (ask IT to grant it).', true));
    const admin = await login(app, ADMIN_A);
    const c = await listed(admin, [S1.email]);
    const r = await admin.post(`/api/campaigns/${c.id}/notify`).send({ kind: 'open' }).expect(502);
    expect(r.body).toMatchObject({ code: 'mail_denied' }); expect(r.body.error).toContain('Mail.Send');
    const a = (await ownerDb().query("SELECT action FROM audit_log WHERE campaign_id = $1 AND action LIKE 'notify.%'", [c.id])).rows.map((x) => x.action);
    expect(a).toEqual(['notify.failed']);
  });

  it('only the creator or a co-admin can send; other admins and staff cannot', async () => {
    const log: Sent[] = []; notifyHooks.mailer = fakeMailer(log);
    const admin = await login(app, ADMIN_A); const other = await login(app, ADMIN_B); const staff = await login(app, S1);
    const c = await listed(admin, [S1.email]);
    await other.post(`/api/campaigns/${c.id}/notify`).send({ kind: 'open' }).expect(404);
    await staff.post(`/api/campaigns/${c.id}/notify`).send({ kind: 'open' }).expect(403);
    await admin.post(`/api/campaigns/${c.id}/team`).send({ email: ADMIN_B.email, role: 'co_admin' }).expect(201);
    await other.post(`/api/campaigns/${c.id}/notify`).send({ kind: 'open' }).expect(200);
    expect(log).toHaveLength(1);
  });
});

describe('Umoja votes', () => {
  it('writes to active members whose account is matched, counts the rest as unreachable, and skips inactive members', async () => {
    const log: Sent[] = []; notifyHooks.mailer = fakeMailer(log);
    await setMembers([['NAM0101', true], ['NAM0102', false], ['EXE0001', true]]);
    await login(app, { ...S1, employeeCode: 'NAM0101' });
    const admin = await login(app, ADMIN_A);
    const c = await makeCampaign(admin, 2, 'Umoja vote', 'umoja');
    await admin.post(`/api/campaigns/${c.id}/start`).expect(200);
    const info = (await admin.get(`/api/campaigns/${c.id}/notify`).expect(200)).body;
    expect(info).toMatchObject({ mailable: true, total: 2, reachable: 1, unreachable: 1, not_voted: 1 });
    expect((await admin.post(`/api/campaigns/${c.id}/notify`).send({ kind: 'open' }).expect(200)).body).toEqual({ sent: 1, unreachable: 1 });
    expect(log[0].bcc).toEqual([S1.email]);
  });
});

describe('the Graph mailer and the message text', () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchOk = ((status = 202) => (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return String(url).includes('/oauth2/') ? new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 }) : new Response('', { status });
  }) as typeof fetch);
  const opts = (f: typeof fetch) => ({ tenantId: 'tenant', clientId: 'client', clientSecret: 'secret', sender: 'voting@namra.test', fetchImpl: f });

  it('gets an application token once, then sends from the sender mailbox with everyone in BCC', async () => {
    calls.length = 0;
    const m = createGraphMailer(opts(fetchOk()));
    await m.send(['a@x.test', 'b@x.test'], 'Subject', 'Body'); await m.send(['c@x.test'], 'S2', 'B2');
    const token = calls.filter((c) => c.url.includes('/oauth2/'));
    expect(token).toHaveLength(1);                                                // cached
    expect(String(token[0].init.body)).toContain('grant_type=client_credentials'); expect(String(token[0].init.body)).toContain('graph.microsoft.com%2F.default');
    const mail = calls.filter((c) => c.url.includes('/sendMail'));
    expect(mail[0].url).toBe('https://graph.microsoft.com/v1.0/users/voting%40namra.test/sendMail');
    const sent = JSON.parse(String(mail[0].init.body));
    expect(sent.message.toRecipients).toEqual([{ emailAddress: { address: 'voting@namra.test' } }]);
    expect(sent.message.bccRecipients).toEqual([{ emailAddress: { address: 'a@x.test' } }, { emailAddress: { address: 'b@x.test' } }]);
    expect(sent.saveToSentItems).toBe(false);
  });

  it('reports a missing permission (403) apart from other failures, and a refused token', async () => {
    await expect(createGraphMailer(opts(fetchOk(403))).send(['a@x.test'], 's', 'b')).rejects.toMatchObject({ permission: true, message: expect.stringContaining('Mail.Send') });
    await expect(createGraphMailer(opts(fetchOk(500))).send(['a@x.test'], 's', 'b')).rejects.toMatchObject({ permission: false });
    const refused = (async () => new Response(JSON.stringify({ error_codes: [7000222] }), { status: 400 })) as unknown as typeof fetch;
    await expect(createGraphMailer(opts(refused)).send(['a@x.test'], 's', 'b')).rejects.toThrow(/AADSTS7000222/);
  });

  it('the messages carry the link, say it is secret and once only, and never claim the reader has not voted', () => {
    const c = { title: 'Chair', description: null, share_url: 'https://app.test/v/abc', closes_at: new Date('2026-11-14T10:00:00Z') };
    const now = new Date('2026-11-14T06:00:00Z');
    for (const kind of ['open', 'reminder', 'closing_soon'] as const) {
      const m = composeMessage(kind, c, now);
      expect(m.text).toContain('https://app.test/v/abc'); expect(m.text).toContain('secret'); expect(m.subject).toContain('Chair');
    }
    expect(composeMessage('closing_soon', c, now).text).toContain('in about 4 hours');
    expect(composeMessage('closing_soon', c, now).text).toContain('12:00 CAT');
    expect(composeMessage('reminder', c, now).text).toContain('if you have already voted, please ignore it');
    expect(composeMessage('open', { ...c, description: 'Pick one', closes_at: null }, now).text).toContain('Pick one');
  });
});
