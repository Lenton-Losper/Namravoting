# Data retention schedule

What is kept, for how long, and how it is removed. The periods below are **defaults chosen by the developer, not legal advice**:
confirm them with the organisation's legal counsel and the Information Regulator's current guidance before the first real election.
Namibia's data-protection legislation has been in draft for some time; check what is in force at the time rather than relying on this page.

| Data | Kept | Then | How |
|---|---|---|---|
| **Sealed result** (per-candidate counters, turnout, the seal fingerprint) | Indefinitely | Kept | It holds no personal data: no voter is linked to a candidate (counters only). |
| **Audit log** (who created, started, closed, reset, exported, approved) | Indefinitely | Kept | Tamper-evident chain; rows hold account ids, not names. Names live in `users` and are removed for leavers (below). |
| **Receipts** (who voted, one per voter) and the **voter list** / **Umoja snapshot** of a campaign | While the campaign is open, then until **24 months after it closed and was archived** | Deleted | Retention job. The campaign row, counters and audit trail stay; the seal then shows "receipts: not applicable". |
| **Candidate photos** | Same as receipts | Deleted | Retention job (files removed from the R2 bucket after the database change commits). |
| **Sessions** | Until they expire (4 h admins / 8 h staff idle, 12 h at most) | Deleted a day later | Done on sign-in. |
| **`users` rows** (name, email, employee code) | While the person is on the staff / Umoja lists | **Anonymised** when they leave | HR gives the list of leavers; `npm run retention -- --apply --leavers leavers.txt`. Name becomes "Former staff member", email `removed-<id>@removed.invalid`, employee code removed, sessions ended. The account id stays so old audit entries still make sense. |
| **Sealed-result backups** in R2 | Indefinitely | Kept | Counters and the fingerprint only (see `disaster-recovery.md`). |

A campaign that is not archived is never purged. Deleting a campaign by hand ("Delete permanently") remains available and needs a copy
of the result to have been exported first.

## Running it

```
npm run retention                                  # dry run: lists what would be removed
npm run retention -- --months 12                   # a different period
npm run retention -- --apply                       # do it
npm run retention -- --apply --leavers leavers.txt # also anonymise the people in leavers.txt (one email per line; keep the file off GitHub)
```

It needs the owner database connection (`MIGRATE_DATABASE_URL`), plus the `R2_*` settings with `STORAGE=r2` to delete photos.

**In GitHub:** the *Retention* workflow runs on the 1st of each month as a **dry run** and prints what it would do in the run summary. To make
the schedule actually delete, set the repository variable `RETENTION_AUTO_APPLY` to `true`. Run by hand it deletes only when "apply" is ticked
and `PURGE` is typed. Leavers are not handled in GitHub (their emails would appear in a public repository's logs).

## Decisions still needed from the organisation
- The periods above (24 months for receipts and photos; leavers anonymised when HR reports them).
- Whether auto-apply should be switched on, or someone should review the monthly report first (the safer default).
- What the legal position is on keeping the audit log and the sealed result indefinitely.
