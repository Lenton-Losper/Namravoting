# Audit: who can see results, "Notify voters of the winner", and the ballot footer

Read-only audit of `main` at `4fb005d` (the deployed code). No code was changed. Method: read the routes, services and screens named below,
and followed every path by which a signed-in voter (a person with no admin role and no team role on the campaign) can receive results or
counts. "Excerpt" lines are `file:line` followed by the code as it is today. Nothing was run against the live database.

Severity scale: **High** = a plain voter can read per-candidate counts or winners. **Medium** = a plain voter can read some count, or a
defect can plausibly make someone vote for the wrong person. **Low** = wording, edge cases, hygiene. **OK** = checked, no change needed.

---

## 1. Results visibility (new requirement: voters never see results)

**Summary.** Today a voter sees results through one API route, one screen on the campaign page (two code paths), and the "Results" entry on
My votes, all of them switched on by the creator pressing **Publish** (or the scheduled publish). Voters can also read a *count* (votes
cleared by a reset) from the notices that ride on the ballot and results payloads, even while voting is open. The admin, observer and
export routes are correctly closed to voters. The cleanest fix is to delete the voter results route and every consumer of it, so the
leak cannot come back, and to keep "published" only as an internal flag (or retire it).

### R1. `GET /api/vote/:shareToken/results` returns the full result to any eligible voter. **High**

`server/src/routes/vote.ts:204-212`

```ts
r.get('/:shareToken/results', async (req, res) => {
  const shareToken = parseToken(req);
  const c = await loadByToken(shareToken);
  const s = await standing(c, currentUser(req));
  if (s.notMember) throw new HttpError(403, notMemberMessage, 'not_member');
  if (!s.eligible) throw new HttpError(403, 'You are not eligible to view these results', 'not_eligible');
  if (c.status !== 'closed' || !c.results_published) throw new HttpError(404, 'Results are not published');
  res.set('Cache-Control', 'no-store').json({ title: c.title, ...(await getResults(getPool(), c.id)), resets: await getResetHistory(getPool(), c.id, false), notices: await getNotices(getPool(), c.id, false) });
});
```

What a voter gets: `getResults` (`server/src/services/campaigns.ts:240-266`) returns every candidate with its vote count, per-position
winners and ties, turnout, the eligible-voter count and the quorum figures:

```ts
return { candidates: cands.rows, positions, turnout, quorum: quorumOf(meta?.quorum_percent, turnout), group_by_region: ...,
```

Gate: only `results_published` (set by the publish route, R7) and eligibility. A voter has no other barrier.

**Change:** delete the route (or answer 404 for everyone who is not creator, co-admin or observer). Stop importing `getResults` into
`vote.ts` so a future edit cannot re-add it. Everything that needs results already has a team-gated route (R7).

### R2. Both voter screens fetch and render the published result. **High**

`client/src/pages/VoteBlocks.tsx:407-410` (campaign page, used for every campaign with positions)

```tsx
const [results, setResults] = useState<(Results & { title: string }) | null>(null);
useEffect(() => {
  if (info.resultsPublished) void api<Results & { title: string }>('GET', `/api/vote/${token}/results`).then(setResults).catch(() => undefined);
}, [info.resultsPublished, token]);
```

`client/src/pages/VoteBlocks.tsx:419-426` and `444-454` render it after "Voting has closed":

```tsx
const published = info.resultsPublished && results && (
  <section className="card card-pad">
    <h2>Results</h2>
    {results.positions ? <PositionResults r={results} /> : null}
```
```tsx
if (info.voterState === 'closed') { ... <BallotState icon="lock" title="Voting has closed" ...>
  <p className="ballot-state-text">{info.resultsPublished ? 'The results are below.' : info.resultsReleaseAt ? `Results will be shared on ...
  ... {published}
```

`client/src/pages/Vote.tsx:28-32` and `185-187` (the older single-ballot screen, still routed for campaigns without positions):

```tsx
function PublishedResults({ token }: { token: string }) {
  ...
  useEffect(() => { api<Results & { title: string }>('GET', `/api/vote/${token}/results`).then(setR).catch(() => undefined); }, [token]);
```
```tsx
{!done && info.voterState === 'closed' && <StateCard icon="lock" title="Voting has closed"><p className="muted">{info.resultsPublished ? 'The results are below.' : 'The results have not been published yet.'}</p></StateCard>}
{info.resultsPublished && <PublishedResults token={shareToken} />}
```

**Change:** remove `PublishedResults`, the `published` section, the `results` state/effect and the `PositionResults`/`ResultsChart` imports from
the voter files. The closed state keeps only "Voting has closed" (plus the voter's own receipt codes, which are not results).

### R3. The "published" flag is sent to voters, and My votes lists "Results" entries. **High** (it is the switch for R1/R2)

`server/src/routes/vote.ts:129` (campaign payload) and `:104` (My votes payload)

```ts
resultsPublished: c.results_published && c.status === 'closed',
...
resultsPublished: c.results_published,
```

`server/src/routes/vote.ts:97` decides which closed campaigns appear on My votes: only the published ones.

```sql
WHERE (c.status = 'open' OR (c.status = 'closed' AND c.results_published))
```

`client/src/pages/MyVotes.tsx:43` turns that into a "Results" chip:

```tsx
<span className={`chip ${l.cls}`}>{c.voterState === 'closed' && c.resultsPublished ? 'Results' : l.text}</span>
```

Side effect to be aware of: a campaign that is closed but **not** published is already hidden from My votes, so today a voter cannot get
back to their receipt code after close unless the result is published. With the new rule that would be *every* closed campaign.

**Change:** drop `resultsPublished` from both payloads; change the query to `status = 'open' OR (status = 'closed' AND <the caller has a
receipt>)` and show a neutral "Closed" chip with a link to the receipt page. Decide how long closed items stay listed (for example 90 days).

### R4. Reset notices carry a vote count, and they reach voters even while voting is open. **Medium**

`server/src/services/campaigns.ts:183-186`

```ts
if (r.action === 'campaign.reset') {
  const snap = r.details?.snapshot ?? {};
  const e: Notice = { kind: 'reset', at: r.at, by: r.by ?? null, reason: String(r.details?.reason ?? ''), votes_cleared: Number(snap.turnout?.votes ?? 0) };
```

`server/src/routes/vote.ts:131` (the voter's campaign payload, any state) and `:211` (R1, `resets:`):

```ts
notices: await getNotices(getPool(), c.id, false),   // resets and early closes, with their reasons (SEC-01)
```

`client/src/ui.tsx:141` prints it to the voter:

```tsx
x.kind === 'reset' ? `reset: ${x.votes_cleared ?? 0} ${x.votes_cleared === 1 ? 'vote' : 'votes'} cleared`
```

The number is the turnout at the moment of the reset. It is not a per-candidate count, but it is a count a voter can read, and it is visible
while the campaign is open (after a reset the campaign re-opens). `withTallies=false` correctly hides the per-candidate tallies.

**Change:** keep the reason and time for voters, drop `votes_cleared` for non-team callers (map it out in `vote.ts`, or add a `forVoter`
flag to `getNotices`). Admins and observers keep the number.

### R5. Copy that promises results to voters. **Low** (and a decision for you)

`client/src/pages/VoteBlocks.tsx:271` (receipt), `:449` (closed state), `:462` (already voted), `client/src/pages/Vote.tsx:185`:

```tsx
<p className="ballot-state-text">Thank you for voting. {release ? `Results will be shared on ${fmtDate(release)}.` : 'Results will be shared after voting closes.'}</p>
```

`server/src/routes/vote.ts:127` sends `resultsReleaseAt` to voters; the admin forms collect it (`NewCampaign.tsx`, `EditCampaign.tsx`).

Under the new rule these sentences are wrong. **This conflicts with the text in `docs/ballot-screen-redesign.md`** ("Results will be shared on
{date}", spec Receipt section and Backend section "results-release date"), which is now out of date. Options: (a) "The winners will be announced
by the administrators." (no date); (b) keep the date but rename it "Winners will be announced on {date}" and pair it with the
announcement feature in section 2. I recommend (b). Needs your decision before anyone edits the spec or the copy.

### R6. Other voter-visible payloads checked. **OK / Info**

- `GET /api/vote/:token` also returns `candidateCount` per position (`vote.ts:138`): a number of *candidates*, not votes. OK.
- `progress: { voted, total }` (`vote.ts:134`) counts the caller's own positions. OK.
- `GET /api/vote/:token/receipts` (`vote.ts:174`): the caller's own codes only. OK.
- `candidate_withdrawn` notices (`campaigns.ts:189`): candidate name and reason, no counts. OK (informational, and intended: voters must
  know why a candidate cannot be chosen).
- A run-off campaign (`admin.ts:792-812`) is built from the tied candidates, so its voters can infer "there was a tie" from the finalists.
  No counts are shown. Info only; inherent to running a run-off.

### R7. Routes confirmed closed to plain voters. **OK**

- Everything under `/api/campaigns` sits behind the admin role gate and then a per-campaign gate:
  `server/src/routes/admin.ts:211` `r.use(requireUser, adminLimiter(), requireAdmin);`, `:92-108` `loadRunnable` (creator or co-admin of that
  campaign, otherwise 404 and an audit entry).
- Per-campaign results and exports: `admin.ts:666` `GET /:id/results`, `:815` `results.csv`, `:847` `results.xlsx`, `:848` `results.pdf`, all
  `loadRunnable`. The sealed-integrity check `GET /:id/verify` is under the same gate.
- Observers use their own router with a membership check (`server/src/routes/team.ts:219-267`); they see turnout while open and the sealed
  result after close:

  ```ts
  result: closed ? await getResults(db, id) : null,
  ```
- While a campaign is open, even the creator sees turnout only, never candidate counts (`admin.ts:672`, `candidates: null`), which matches
  the live test I ran after the deploy.
- There is no unauthenticated results route; `/api` requires a session (`app.ts:46-52`).

### R8. What the publish machinery becomes

Publishing exists only to unlock R1/R2/R3: `admin.ts:701-721` (`POST /:id/publish`, with the seal check at `:707-711` and the quorum check at
`:713-716`), `admin.ts:724` (`PUT /:id/publish-schedule`), `services/campaigns.ts:117-142` (lazy scheduled publishing) and the admin chip
`client/src/pages/admin/CampaignPage.tsx:190-192` ("Published to voters"). If voters never see results, "publish" has no audience. Two
options: retire it, or repurpose it as **"announce the winners"** (section 2), keeping the seal/quorum checks as its preconditions. I recommend
the second: the checks are valuable and the audit action `results.publish` already exists. Existing rows with `results_published = true`
would simply stop showing anything to voters; tell the creators.

### R9. Tests that currently pin voter results (must be rewritten)

By grep, voter-results calls or `resultsPublished` appear in about 20 server test files (`api`, `flow`, `quorum`, `umoja`, `umojaMatch`, `cleanup`,
`editAfterStart`, `phase1`, `multiVote`, `access`, `roleSeparation`, `runoff`, `positionResults`, `receiptCode`, `phase3c`, ...) and 8 client test
files (`a11y`, `positions`, `quorum`, `ballot`, `abstain`, `session`, `signal`, `withdraw`). Most only publish and read as a voter to prove
something else; they should read through the admin route. Add one structural test: after closing and (formerly) publishing, a voter
session gets 404/403 from every `/api/vote/*` route and no JSON key named `votes`, `candidates[].votes`, `turnout` or `winners` appears in
any voter response.

---

## 2. "Notify voters of the winner" (new requirement), assessment only

### N1. Getting the list of people who voted, without their choice. Feasible, and the code already does the inverse.

Receipts hold who voted and nothing about the choice (`vote_receipts`: campaign, position, voter, member key, receipt code; no candidate, no
timestamp). `audienceFor` already joins receipts to users to find the people who have **not** voted:

`server/src/services/notify.ts:81-98`

```ts
export async function audienceFor(db: Queryable, c: { id: string; eligibility: 'all' | 'list' | 'umoja' }): Promise<Audience> {
  if (c.eligibility === 'all') return { mailable: false, total: 0, reachable: 0, pending: [], all: [], unreachable: 0 };
  const rows = c.eligibility === 'list'
    ? (await db.query(`SELECT e.voter_email AS email, EXISTS (SELECT 1 FROM users u JOIN vote_receipts r ON r.voter_oid = u.entra_oid AND r.campaign_id = $1 WHERE u.email = e.voter_email) AS voted ...
```

The winners list is the same query with `voted = true`. Two caveats:

1. **Campaigns open to all staff are "not mailable" today** (`notify.ts:82`) because there is no voter list. For *winners* that restriction is
   unnecessary: every receipt has a `voter_oid`, and `users` has the email, so recipients can be derived from receipts alone for every
   eligibility mode (for Umoja ballots the receipt's `member_key` maps through `employee_code`, as `audienceFor` already does).
2. **Receipts are deleted by retention** once a campaign is closed and archived for N months (`server/src/services/retention.ts:15-24`,
   `purgeCampaign`). The announcement must be sent before archive/purge; the screen should refuse once `receipts_purged_at` is set.

The list must stay inside one server function and never be returned to the browser or logged (counts only), as the reminder feature does
(`routes/notify.ts:29`, "Counts only. Who has not voted is not shown to anyone.").

### N2. Delivery options

| Option | Needs | Works today? | Secrecy / privacy | Verdict |
|---|---|---|---|---|
| **A. Email via Microsoft Graph** (`Mail.Send`) | IT grants the app the *application* permission `Mail.Send` plus admin consent and names a sender mailbox (`NOTIFY_SENDER`); the app must run `AUTH_MODE=entra` with a valid client secret; ideally an Exchange application access policy limiting the app to that mailbox | **No.** The mailer only exists when `AUTH_MODE=entra`: `config.ts:73` `const entra = e.AUTH_MODE === 'entra' ? parseEntra(e) : null;` and `notify.ts:66-71` `if (!c.entra \|\| !c.notifySender) return null;`. The live app is `email-demo` and the Entra secret is expired. | Mail stays inside NamRA's tenant. Recipients are Bcc'd in batches of 100 (`notify.ts:52`, `routes/notify.ts:52`) and nothing is saved to Sent Items (`saveToSentItems: false`). Exchange transport logs will still list the recipients, i.e. who voted (never how). | Best long-term channel; blocked on IT and on switching back to Entra. Code is already written. |
| **B. Email provider** (Resend, Postmark, SendGrid, SES, MailChannels) | An API key as a secret, and DNS records (SPF, DKIM, DMARC) for the sending domain from IT; a new `Mailer` implementation behind the existing `Mailer` interface (`notify.ts:17`) | Yes, in any auth mode, once the key and DNS exist | A third party receives every voter's address and the message. Wider exposure than A. | Only if IT refuses A. |
| **C. In-app announcement on My votes / the campaign page** | A short text stored with the campaign, shown to people who have a receipt for it (checked at read time from `vote_receipts`) | **Yes**, no IT dependency, works in `email-demo` | No recipient list is created or stored at all; nobody has a "delivered" record, so there is nothing that links people to anything. Strongest secrecy. Only reaches people who open the app. | Do first. |
| **D. "Copy announcement" text for WhatsApp / Teams** | A button that copies a prepared message | **Yes**, zero infrastructure | The creator posts it to a group; it cannot be limited to "people who voted", and the app sees nothing about delivery. | Do first, as the fallback and the push channel until A exists. |

### N3. Message content

One text, identical for every recipient (no per-person link or token, which would make the mail traceable to a person):

- Subject: `Result: <campaign title>`.
- Body: per position, the winner(s) by name (all seat holders for choose-N positions); "no winner, a run-off will be held" for a tie; the date
  voting closed (Windhoek time); who announced it; a link to the app (sign-in page), not to a results page.
- **No vote counts, percentages, turnout, or quorum figures.** That keeps the mail consistent with the new rule that voters never see
  results, and removes the main way a mail could be used to infer how someone voted.
- No receipt codes, no names of voters, no attachment, no tracking pixel.
- Generated server-side from the **sealed** result, not typed by the admin; the admin sees a preview and can add one optional sentence.

Preconditions (all already implemented for publishing, reuse them): campaign `closed`; the seal verifies (`admin.ts:707-711`); quorum met or
knowingly overridden (`admin.ts:713-716`); a tied position blocks the send until a run-off is held or the admin confirms the wording; receipts
not purged.

### N4. Audit logging

Same pattern as the reminders: one hash-chained entry on success `notify.sent`-style (`routes/notify.ts:58`, counts only; nobody is named),
action `results.announce` for the in-app/copy announcement, `notify.winners_sent` for email, and `notify.failed` with the partial count on
failure (`routes/notify.ts:54`). Record a SHA-256 of the message text in the entry so the exact wording is provable. Observers already see
these entries through the audit bundle.

### N5. Preventing double sends. The current guard is not enough.

`server/src/routes/notify.ts:47-48`

```ts
const recent = await getPool().query("SELECT 1 FROM audit_log WHERE campaign_id = $1 AND action = 'notify.sent' AND details->>'kind' = $2 AND at > now() - make_interval(mins => $3)", [c.id, kind, MIN_INTERVAL_MINUTES]);
if (recent.rowCount) throw new HttpError(409, `This notice was sent less than ${MIN_INTERVAL_MINUTES} minutes ago`, 'too_soon');
```

This is read-then-send: two simultaneous clicks both read "nothing recent", and both send (**Medium** for the existing reminders, and it would be
unacceptable for a one-time winners mail). The audit row is only written *after* the send loop (`:58`). A partial failure (`:53-57`) also
leaves earlier batches delivered, and a retry would resend them. For the new feature:

1. Claim atomically before sending: `UPDATE campaigns SET winners_announced_at = now(), winners_announced_by = $2 WHERE id = $1 AND winners_announced_at IS NULL RETURNING id`;
   no row means someone already did it (409).
2. For email, store how many batches went out (a number, not people) so a failed send resumes from the next batch instead of repeating.
3. Disable the button after success; a deliberate re-send needs a typed reason, is audited, and is limited to the people who have not yet received it
   (impossible to know without a recipient list, which is exactly why in-app announcement (C) has no double-send problem at all).

### N6. Secrecy implications, summarised

- The winner mail goes only to people with receipts. Anyone who can read the Exchange mailbox audit or transport logs can see the recipient list, i.e. who
  voted in total, never for whom. The reminder feature already exposes the inverse set (non-voters) the same way; treat both as "restrict
  mailbox access to the sender account".
- Sending winners to *voters only* reveals participation to the recipient only (they know they voted). Sending to *all eligible* people would need no
  receipts at all; but for "all staff" votes there is no eligible list, so a voters-only send is the workable one.
- Do not log, cache, or return the recipient list; build it in the request, send, discard.
- Do not add anything to the message that depends on the recipient (no "you voted for ..." obviously, and no per-person receipt code).

### N7. Recommendation (not built)

1. **Phase 1, now, no IT dependency:** repurpose "Publish results" as **"Announce winners"**. After the close and the existing seal/quorum checks, the
   creator sees a generated preview (names only), presses *Announce*, and the app (a) stores the text on the campaign, (b) shows it on the campaign
   page and My votes to people who have a receipt, and (c) offers **Copy text** for WhatsApp/Teams. One atomic claim, one audit entry
   (`results.announce`, with the text hash). This also gives the receipt wording in R5 something truthful to point at.
2. **Phase 2, when IT grants `Mail.Send` and the app is back on `AUTH_MODE=entra`:** add a "Also email everyone who voted" step that reuses
   `createGraphMailer` and `BATCH` (`notify.ts:28-61, 73`), a new `winners` kind in `composeMessage`, and the receipts-derived audience (N1), guarded by the atomic claim
   (N5). Verify with one test mailbox first.
3. Skip option B unless IT refuses A.

---

## 3. Ballot footer: "Review vote for Gwen" while the visible card's radio was empty

### B1. The footer and the cards always agree in the code. **OK**, with three edge cases

Both read the same state, `picked` (`client/src/pages/VoteBlocks.tsx`):

```tsx
const on = picked.includes(c.id);                                              // :279  card highlight and aria-pressed (:284)
const chosen = picked.map((id) => all.find((c) => c.id === id)).filter(...);   // :213
`Review vote for ${firstName(chosen[0].name)}`                                 // :369  footer
```

Every writer of `picked`: restore after sign-in (`:192-196`), the filter-hides-it effect (`:209-212`), `toggle` (`:219-228`), clear on success (`:237`),
clear on a definitive error (`:243`). None of them updates the footer without the card or the reverse. So the reported symptom is not a
state mismatch in the normal flow. Edge cases where they can differ:

- **B1a. A selected candidate who becomes withdrawn stays selected. Low.** After `load()` refreshes the ballot (`:246`, `recheck`) the card turns
  withdrawn (disabled), but `picked` still holds the id (`toggle` ignores withdrawn at `:220`, and the cleanup effect at `:211` only checks the region
  filter). The footer still says "Review vote for X", the card is greyed and disabled but still styled selected, and Submit fails with `candidate_withdrawn`
  (409). Fix: drop withdrawn ids from `picked` when the ballot reloads.
- **B1b. One render of lag when the region filter hides the pick. Low.** The effect at `:209-212` clears it after render, so for one frame the footer names a
  candidate whose card is not shown. Cosmetic.
- **B1c. The footer shows the first name only (`firstName`, `:369`). Low/Medium.** Two candidates sharing a first name (for example "Gwen Amupolo" and
  "Gwen Kaura") make "Review vote for Gwen" ambiguous: the visible Gwen card can be the other one, with an empty radio. The confirm sheet shows the full
  name and region, which limits the harm.

### B2. The selected card is highlighted but never scrolled into view. **Medium**, and the most likely cause of what you saw

Highlight: yes. `.ballot-card.is-selected` gives a navy border, a glow, a tinted fill, and the filled dot or check (`client/src/styles.css:445`).

Scroll into view: **no.** `grep scrollIntoView` finds nothing in `VoteBlocks.tsx`; the only `.focus()` calls are inside the sheet's focus trap (`:100,109,110`). Nothing
scrolls to the chosen card, and the sticky footer is always on screen, so with a long list (13 compact cards is several screens) the footer can name a candidate
whose card is off-screen. The visible cards then all show empty radios. Paths into that state:

1. The voter taps Gwen, scrolls down to compare others, and the footer keeps saying Gwen (most common).
2. **Restore after re-sign-in** (`:192-196`): the pending pick is restored from `sessionStorage` and the page opens at the top; Gwen's card may be far down.
3. Choose-N positions, where the footer says "Review 2 votes" or "1 of 2 selected" and the picked cards are scattered.

I could not reproduce it at runtime (static reading only), so which path it was is a probability, not a certainty. The data is consistent; the *presentation* hides it.

**Suggested fix (not applied):** show the full name in the footer ("Review vote for Gwen Amupolo"), add a one-line "Selected: Gwen Amupolo, Khomas" row above the
button with a "Show" link that scrolls the card into view, scroll the restored pick into view on load, and drop withdrawn ids from `picked` (B1a).

---

## 4. Prioritised fix list

| # | Fix | Severity | Effort | Notes |
|---|---|---|---|---|
| 1 | Delete `GET /api/vote/:t/results` and the voter result sections (R1, R2); remove `resultsPublished` from voter payloads (R3); My votes lists closed campaigns the voter voted in, as "Closed" with the receipt | **High** | S-M | Update about 28 tests (R9); add the structural "no counts in any voter response" test |
| 2 | Strip `votes_cleared` (and any count) from notices for non-team callers (R4) | **Medium** | S | One mapper in `vote.ts`; also fixes it appearing while a campaign is open |
| 3 | Decide the wording (R5) and update copy + `docs/ballot-screen-redesign.md` | Low (decision) | S | Needs your choice: no date, or "Winners will be announced on {date}" |
| 4 | Ballot footer: full name, "Selected: ..." row with a jump link, scroll restored pick into view, drop withdrawn picks (B1a, B1c, B2) | **Medium** | S | Client only; add tests |
| 5 | "Announce winners" (phase 1: stored announcement, shown to people with a receipt, Copy text, atomic claim, audit entry) replacing "Publish results" (R8, N7) | Feature | M | Reuses the seal and quorum checks from publishing |
| 6 | Make the existing reminder double-send guard atomic (N5) | **Medium** (existing feature) | S | Same claim pattern |
| 7 | Phase 2 email of winners via Graph once IT grants `Mail.Send` and the app is back on Entra (N7) | Feature | M | Blocked on IT and on the expired Entra secret |
| 8 | Retire or repurpose `publish-schedule` and the "Published to voters" chip (R8) | Low | S | Follows from 1 and 5 |

Open questions for you: (a) wording in R5; (b) how long closed campaigns stay on My votes; (c) whether a tied position blocks the announcement or only warns;
(d) whether the winners message should name the region, which is already public on the ballot.
