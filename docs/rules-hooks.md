# Election rules: where they plug in

Election rules are **not built yet**. Today every position is a plain contest: one vote per member, the candidate with the most votes
wins, a tie for first place has no winner. This page says where a rule goes when the meeting decides one, so adding it does not mean
rewiring the vote, the results or the exports.

## The two hooks

Both live in one file, `server/src/domain/rules.ts`, and are pure functions (no database, no clock), so a rule can be unit-tested on its own.

```ts
validateBallot(position, member, candidate): void      // throw BallotRejected to refuse
computeResult(position, tallies): { winners, tied }    // who won this position
```

| Hook | Called from | When | What it may do |
|---|---|---|---|
| `validateBallot` | `services/voting.ts` (`castVote`) | Inside the vote transaction, after eligibility and the one-vote-per-position insert, **before** the counter is incremented | Refuse the ballot by throwing `BallotRejected(message, code, status)`. The whole transaction rolls back (no receipt, no count) and the voter gets the message and code. |
| `computeResult` | `services/campaigns.ts` (`getResults`) | Whenever a closed campaign's result is built: the results page, voters' published results, the CSV, Excel, PDF, the audit bundle, the sealed-result copy, the admin position blocks | Decide the winner(s) and the tie of one position from its final counters. Nothing else in the code decides who has won. |

`position` carries `seats`, `minCandidates`, `maxCandidates` and `rules`. `rules` is the **per-position `rules` JSON column** (migration 019).
It is unused today (`{}`); a rule reads its settings from there, for example `{"maxPerRegion": 1}`. The database locks `rules` (and `seats`,
the limits, the order) from the moment the campaign starts, so a rule cannot change under voters.

`member` is `{ key, oid }`: who is voting, **only so the rule can decide whether the ballot is allowed**. It must not be stored next to the
candidate. `candidate` carries `regionId`, `regionName`, `isAbstain` and `withdrawn`.

## What is already in place for rules

* **Seats**: `positions.seats` (default 1). `computeResult` may return up to `seats` winners; the results, CSV, Excel and PDF already print
  "Winner: A, B" for a position with several winners. The vote itself is still one choice per member per position.
* **Candidate limits**: `positions.min_candidates` / `max_candidates` are enforced at the start check and when adding or approving candidates.
* **Regions**: every candidate has a region, and `validateBallot` receives it, so region rules do not need new data.
* **Per-position data**: tallies are per (campaign, position, candidate), receipts per (campaign, position, member), and each position is
  sealed with its own fingerprint. A rule that needs a per-position or per-region count reads the counters; it never needs a ballot row
  (there are none).
* **Tests**: `server/tests/integration/rulesHooks.test.ts` plugs a "blocked region" rule into `validateBallot` and a "two seats" rule into
  `computeResult` using only the `rules` JSON, and shows the vote, results and CSV follow, with no other change.

## Recipes (not implemented; for the meeting to confirm)

* **Region quota** (for example, at most one winner per region, or at least one per region): a quota that depends on *how others voted* is
  a `computeResult` rule (pick winners subject to the quota). A rule that only restricts *who may be chosen* is a `validateBallot` rule.
* **Several seats**: set `positions.seats`; `computeResult` returns the top `seats` and `tied` for a tie at the boundary. A run-off for a
  boundary tie needs the run-off flow to understand positions (today it is refused for campaigns with several positions).
* **"Must vote in every position"**: this is a rule about the *set* of a member's votes, which no single `validateBallot` call sees. The
  vote of each position is its own transaction by design. Two ways: (1) treat it as "the campaign is not complete for a member until every
  block is done" and show it (progress is already on the page: `progress.voted / progress.total`), or (2) a new third hook
  `campaignComplete(member, positionsVoted)` called from the vote route. Ask the meeting whether a partial ballot is allowed, or must be refused.
* **Minimum turnout per position**: the quorum exists per campaign today (`quorum_percent`); a per-position quorum is a `computeResult`
  concern (return no winner when the position's turnout is below it).

## Rules of the road for whoever adds a rule

1. Put it in `domain/rules.ts` (or a module it calls). Do not add rule checks to routes, the vote transaction or the exports.
2. Never log, audit or return the candidate a member chose. `validateBallot` runs inside the secret part of the vote.
3. A `validateBallot` rule must be decidable from the position, the member and the candidate alone. If it needs counts, it is a
   `computeResult` rule.
4. Settings go in `positions.rules`; add a field-level validation where positions are edited (`domain/validation.ts`, `routes/positions.ts`).
5. Add a test next to `rulesHooks.test.ts`. The default behaviour tests (`tests/unit/rules.test.ts`) must keep passing.
