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
