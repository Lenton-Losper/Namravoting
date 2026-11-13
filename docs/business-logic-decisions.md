# Business-logic items: what was built, and the decisions behind each

The plan (`business-logic-plan.md`) listed a decision for each item. None had been answered when these were built, so each item
uses the default below. Every default is a setting or one small piece of code, so changing a decision does not need a redesign.
Items built on the demo day are NOT deployed yet.

## 1. Ties
- **Rule: a tie for first place goes to a run-off.** Abstain lines and withdrawn candidates can neither win nor tie.
- **Maximum run-offs: 2** per campaign (`MAX_RUNOFFS`, 0 to 5). After that the page says the tie has to be decided another way.
- Results, the CSV, Excel and PDF all say "Tie for first place" and do not name a winner. Voters see it in published results.
- "Start run-off" (creator only, closed campaign, tie, none started yet) creates a **new draft** with the tied candidates (their
  photos are copied, not shared), the same eligibility mode and the same voter list (a listed vote copies its emails; an Umoja vote
  takes a new member snapshot when it starts). It is started like any campaign, so it gets its own snapshot and seal.
  The link is `campaigns.parent_campaign_id` and `runoff_round`; the database refuses to change them. Audit: `campaign.runoff_created`.

## 2. Abstain / none of the above
- **Off by default**, per campaign, set on the create or draft edit screen, locked from the moment the campaign starts (also in the database).
- **Wording: "Abstain (none of the above)"** (last on the ballot; asks "Abstain from this vote?" before it is cast).
- It is stored as a candidate row flagged `is_abstain`, so it has a tally counter like every candidate and the check "receipts = sum of
  tallies" and the seal work unchanged. It counts as a vote cast (turnout), can never be the winner or part of a tie, does not count
  towards the 2 candidates needed, and cannot be edited or removed on its own.
- Results, CSV, Excel and PDF report abstentions on a separate line. Percentages are of ballots cast.
- A run-off is not given an Abstain line (the creator can switch it on while the run-off is still a draft).

## 3. Co-admins, observers, second approver
- **Roles per campaign:** the creator (owner); **co-admins** can run it (edit, start, close, publish, export, run-off) but cannot reset,
  delete, archive or change the team; **observers** are read-only: turnout, the sealed result once closed, the integrity check, the team,
  approvals and the audit trail. Observers never see per-candidate counts while a campaign is open (the old round's counts in a reset entry
  are held back too). Observers see it at `/observe`; the "Observing" link appears only for people who observe something.
- **Who may be an observer: anyone the owner adds** (HR, a union representative, internal audit). They must have signed in once. Every
  addition and removal is audited (`team.add`, `team.remove`). A co-admin must already be a campaign administrator
  (ADMIN_OIDS or the app role), because they work in the admin area. At most 20 people per campaign.
- **Second approver: both reset and permanent delete, per campaign, off by default** ("Require a second approver", on the create form
  or the Team tab). Once on it can never be switched off (the database refuses). The creator requests, a co-admin (never the
  requester) approves or rejects, the creator carries out an approved request within 24 hours. Every step is audited. The database
  refuses an approval by the requester and any edit to a request. With no co-admin on the campaign nothing can be approved,
  so add one first.
- Honest limit: the "must be approved first" check is made by the application when the creator carries the request out; the two-person rule on the
  approval record itself is enforced by the database. Resets and deletes still run through the creator's own session in the database functions.

## 4. Candidate withdraws
- **Policy: votes already cast for a withdrawn candidate are void.** They stay in the counters (so turnout and the seal are unchanged) but
  are reported separately ("withdrew: votes void"), are never counted towards a winner or a tie, and the candidate stays on the ballot,
  greyed and impossible to choose.
- **Voters are not asked to re-vote**, because a ballot is secret: nobody can say who voted for the candidate. If the creator wants
  everyone to vote again they use "Reset votes" (a withdrawn candidate stays withdrawn after a reset).
- Needs a reason of at least 10 characters (audit entry `candidate.withdrawn`, shown to voters on the ballot and in published results), an
  open campaign, and at least 2 candidates left in the running. The creator or a co-admin can do it. It cannot be undone, and the database
  allows nothing else about a candidate to change while the campaign is open (migration 016).

## 5. Retention and deletion
- **Written schedule:** `docs/retention.md` (defaults, not legal advice: confirm with counsel). **24 months** after a campaign is closed AND
  archived, its receipts, voter list, Umoja snapshot and candidate photos are deleted; the sealed result and the audit chain stay forever.
- **The job:** `npm run retention` (dry run unless `--apply`), owner database role, every step audited (`retention.purged`). The Retention
  workflow runs monthly as a **dry run**; deleting on the schedule needs the repository variable `RETENTION_AUTO_APPLY=true`, so a person
  reads a report first by default. By hand it needs "apply" ticked and `PURGE` typed.
- **Leavers:** `--leavers file` anonymises name, email and employee code and ends sessions; the account id stays. Done on the operator's
  machine, not in GitHub (the emails would show in a public repository's logs). Someone who still runs a draft or open campaign is skipped.
- A purged campaign shows a note on its page, verifies with "receipts: not applicable", and cannot be reset.

## 6. Backup, restore, disaster recovery
- **Built:** a copy of every sealed result (counters + the seal fingerprint, no personal data) is written to the R2 bucket at close, manual or
  automatic (`sealed-<campaign>-<seq>.json`, audited `result.backed_up`; a storage failure is recorded as `result.backup_failed` and never blocks
  a close). `npm run backup:sealed` copies earlier campaigns. `npm run restore:check` tells whether a restored database is a faithful copy
  (migrations, audit chain, receipts = counters, sealed results = counters, copies present). The Monitor workflow checks the app and the
  Microsoft sign-in every 15 minutes from outside, and alerts by failed run (and an optional Teams/Slack webhook). Runbook: `docs/disaster-recovery.md`.
- **Neon point-in-time restore: checked, NOT changed.** The window is **6 hours** (read with `node scripts/neon-check.mjs`). I tried to raise it to
  24 hours and the tool permission check refused to let me change the shared Neon project, so it is unchanged. It is a plan/setting change
  for the account owner (Neon console, Settings, Storage, Restore window).
- **Restore drill: script written, NOT run.** It creates and deletes a Neon branch in the shared account, which I was not permitted to do from here.
  Run `node scripts/restore-drill.mjs` once and record the result in `docs/disaster-recovery.md`.
- **Defaults assumed:** acceptable downtime 1 hour; alerts go to whoever GitHub notifies, plus an optional webhook.

## 7. Notifying staff
- **Channel: email through Microsoft Graph** (application permission `Mail.Send`), from the mailbox in `NOTIFY_SENDER` (a Worker variable; unset = off,
  and the screen says so). **Needs IT:** grant `Mail.Send` (admin consent) to the NamRA Voting app registration and choose the sender address.
  Not tested live: the Graph calls are covered by tests with a fake Microsoft.
- **Three notices, sent by a button** (creator or co-admin, open campaigns): "voting is open" (everyone with a known address), "reminder" (people without a
  receipt), "closing soon" (people without a receipt; needs a closing time). Each kind can be sent once per hour.
- **Privacy:** one message per batch of 100 with everyone in BCC, so no recipient sees who else got one. The creator sees counts only
  ("8 of 10 reachable, 5 have not voted"), never names, and the audit entry holds counts only. The reminder text never claims the reader has not voted.
- **Who can be reached:** a listed vote (the listed emails) and an Umoja vote (active members whose account is known: matched by account id or by
  employee code). A vote open to **all staff has no list to write to**: share the link or QR code, or use a listed vote.
- **Not built:** automatic scheduled sending (there is no scheduler in the app; the buttons are manual). A schedule could call the same endpoint later.

## 8. Quorum, scheduled publishing, "approved by"
- **Quorum: optional, per campaign, as a percentage of the eligible voters** (1 to 100). Set on the draft, locked at start (also in the database). It
  needs a known voter list (Umoja or a list of emails), not "all staff". A result below it is flagged everywhere (results, voters' published
  results, CSV, Excel, PDF, observers). It can still be published, but only after the creator acknowledges it (audited `below_quorum`).
  Whether Umoja's constitution has a quorum is yours to say: nothing is on by default.
- **Scheduled publishing:** the creator or a co-admin sets a time; the closed result is published the first time anyone looks at the campaign after
  that (like the automatic close; there is no scheduler). It is **never published automatically** if the result is below quorum or no longer matches its seal
  (recorded once as `results.publish_blocked`): a person decides.
- **"Approved by":** every publication records who and when (`published_by`, `published_at`; the database refuses one without them and refuses
  to alter it). For a scheduled one it is the person who scheduled it. Shown to voters with the published results, in the CSV, Excel and PDF.
  Results published before this was built show no "approved by" line.

## 9. Audit export for Umoja leadership
- **One download: `audit-bundle.zip`** (Results tab, closed campaigns only; also for observers of that campaign). Opens with any zip tool. Contents:
  `results.pdf`, `results.xlsx`, `results.csv` (the result, turnout against the frozen voter count, tie, quorum, abstentions, withdrawals, every
  reset, early close and edit with its reason, the seal fingerprint, who published), `audit-log.csv` (every audit entry of the campaign with its
  hashes, in the exact form the chain was computed), `verify-audit.mjs` (recomputes each entry's hash; `node verify-audit.mjs audit-log.csv`) and a
  `README.txt` with the audit-chain status and seal check at the time of export and how to verify.
- **Format: PDF + CSV as asked, plus Excel and the log.** Who receives it is your decision (default: the creator, co-admins and observers of that campaign).
- Each download is audited (`results.export_bundle`) and counts as the copy needed before a permanent delete. It holds no vote and no receipt.
- Honest limit: the bundle holds only this campaign's entries of a system-wide chain, so the script proves each entry is unaltered, not that nothing was
  inserted between them; the README says so, and the whole chain is checked by the system ("Verify results integrity").
