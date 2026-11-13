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
