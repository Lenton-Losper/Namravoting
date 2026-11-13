# Backup, restore and disaster recovery (one page)

**Where the data lives:** the Neon Postgres database holds everything that matters (campaigns, counters, receipts, the audit chain,
sessions). The Cloudflare container holds nothing: it can be thrown away and redeployed at any time. R2 holds candidate photos and a copy of
every sealed result.

## What protects what

| Risk | Protection | Limit (be honest) |
|---|---|---|
| A mistake or corruption in the database | Neon **point-in-time restore**: fork the database as of a moment in the past | The window on the current Neon plan is **6 hours** (checked with `node scripts/neon-check.mjs`). Anything noticed later cannot be rolled back, only compared with the sealed-result copies. Raising it is a Neon plan/setting change: Neon console, Settings, Storage, Restore window. |
| Losing the database completely | The **sealed result of every closed campaign** is copied to the R2 bucket at close (`sealed-<campaign>-<seq>.json`: counters + the seal fingerprint, no personal data) | The copies do not contain receipts, so a lost database cannot be rebuilt from them; they prove what the results were. |
| Someone changing the audit trail or a counter | Hash-chained audit log, `Verify results integrity`, and `npm run restore:check` | Detects, does not prevent, an owner-level change. |
| The container or the Worker is down | Redeploy from `main` (GitHub: Actions, Deploy, "Run workflow", type DEPLOY). Sessions and votes are in the database, so nothing is lost | A redeploy takes about 5 to 10 minutes. |
| Microsoft sign-in stops working | The *Monitor* workflow checks the app and the Microsoft sign-in every 15 minutes from outside; the secret expiry is tracked (see `operations.md`) | An expired Entra secret locks everyone out until a new one is set. |

## Alerts
The *Monitor* workflow (`.github/workflows/monitor.yml`) runs every 15 minutes **from GitHub**, not from Cloudflare, so it still runs when the app is down.
- **A red run is the alert**: GitHub emails the people watching the repository or who last edited the workflow.
- **Optional:** add the repository secret `ALERT_WEBHOOK_URL` (a Microsoft Teams or Slack incoming webhook) to get a message in a channel.
- Scheduled runs can be late by several minutes, and GitHub pauses schedules after 60 days without repository activity (re-enable it in the Actions tab).

## Runbook

**A. The app is down (monitor is red, or people report errors)**
1. Open the app URL. If you get a Cloudflare error, check the Worker in the Cloudflare dashboard; if it is only slow, wait 1 minute (cold start).
2. Run the Deploy workflow on `main` (it rebuilds the container and redeploys; it does not touch data unless a migration is pending).
3. Still down: check Neon (console.neon.tech) is reachable; check the Worker logs for `database` errors.

**B. Data looks wrong, or someone made a mistake (within the restore window)**
1. **Stop voting:** do nothing else to the database. If a vote is running, tell people to wait.
2. In the Neon console create a **branch from a time just before the mistake** (Branches, Create branch, "Time" option).
3. Check that branch: `RESTORE_CHECK_URL=<branch owner connection string> npm run restore:check`. Every line must say PASS.
4. Point the app at the branch: set the `DEMO_DATABASE_URL` / `DEMO_OWNER_DATABASE_URL` secrets to the branch (or promote it to the default branch in Neon), then run the Deploy workflow. Votes cast after the restore point are lost: say so to the voters.
5. Record what happened (it goes in the audit log of the restored database as a note from the operator, and in your incident notes).

**C. The database is lost or the restore window has passed**
1. The results are not lost: read each closed campaign's `sealed-*.json` from the R2 bucket and publish them as the official results (the fingerprint is the hash of the audit entry; the audit log, if it can still be read, verifies it).
2. Open votes cannot be recovered. Restart them (create the campaign again) and tell the voters.
3. Create a fresh Neon database (`node scripts/neon-setup.mjs`), run the Deploy workflow (it migrates), re-import the Umoja list (`npm run umoja:import`).

**D. After any restore:** `npm run restore:check` on the live database, then `npm run backup:sealed` (re-creates any missing sealed-result copies).

## Restore drill
`node scripts/restore-drill.mjs` forks the live database to a temporary Neon branch, runs `restore:check` on it and deletes the branch. The live database is only read.

| Date | Who | Result |
|---|---|---|
| (not run yet) | | The script was written and its checks are covered by automated tests against a test database. It has **not** yet been run against Neon: it creates and deletes a branch in the Neon account, which needs someone with authority over that account to run it. Run it once before the first real election and record the result here. |

## Decisions still needed from the organisation
- **Acceptable downtime during a vote** (the default assumed here: up to 1 hour; recovery steps above take 10 to 30 minutes).
- **Who gets the alert** (today: whoever GitHub notifies; add a Teams or Slack webhook for the operators).
- **The Neon restore window:** 6 hours today. For a real election, buy a longer window or agree that the sealed-result copies are the safety net.
