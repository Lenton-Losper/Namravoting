# Operations settings

Settings the app reads from its environment (Worker vars and secrets in the Cloudflare deployment). Only the ones added for the
security fixes are described here; `.env.example` lists the rest.

| Setting | What it does |
|---|---|
| `ADMIN_OIDS` | Comma-separated Entra **object ids** of the campaign admins. Preferred. When set, `ADMIN_EMAILS` is ignored unless `ADMIN_EMAILS_FALLBACK=true`. |
| `ADMIN_EMAILS` | Fallback only: admins matched by email. An email can be renamed or reused for a different person, so the app warns at start-up and shows an admin banner while this is the only admin source. |
| `DEMO_MEMBER_EMAILS` | Demo override: these accounts count as Umoja members regardless of the HR list. **In production the app refuses to start with it set unless `DEMO=true`.** Leave it empty for a real election. An admin banner and a start-up log line show whenever it is active. |
| `DEMO` | `true` only on the demo deployment. Required while `DEMO_MEMBER_EMAILS` is set in production. |
| `ENTRA_SECRET_EXPIRES_AT` | The date the Entra client secret expires (`2027-05-30` or a full ISO time). From 30 days before, the server logs a warning at start-up and daily, and admins see a banner. After it, the banner is red. If unset, the server logs that nothing is tracking the expiry. |

## Sessions, keys and throttling

| Setting | What it does |
|---|---|
| `SESSION_SECRET` | Root secret. Three separate signing keys are derived from it (session cookie, sign-in flow cookie, CSRF), so a signed value of one kind never verifies as another. |
| `SESSION_SECRET_PREVIOUS` | Optional. The old `SESSION_SECRET` during a rotation: accepted for verifying cookies only, never for signing. Remove it once old cookies have expired (sessions are sliding: admins time out after 4 hours idle, staff after 8, and none lasts longer than 12 hours in total). |
| `CSRF_SECRET` | Optional. Makes the CSRF key independent of `SESSION_SECRET`, so it can be rotated without touching sessions. Changing it is invisible to users (the page fetches a new token). |
| `AUTH_RATE_LIMIT_PER_MIN` | Per client address, for `/auth/*` (default 30); `/api/csrf` gets four times this. |
| `READ_RATE_LIMIT_PER_MIN` | Per user, for the voter GET routes (default 120). |
| `ADMIN_RATE_LIMIT_PER_MIN` | Per user, for the admin routes (default 60). It now runs before the admin check. |

Sessions are stored in the `sessions` table (a hash of the random session id, never the id itself). Logout revokes the row, so a copied
cookie stops working at once. Roles are recomputed on every request, so removing someone from `ADMIN_OIDS` takes effect immediately.
The rate limits are in memory, for the one container instance: they reset when it restarts.

## Other settings and behaviours

| Setting / behaviour | What it does |
|---|---|
| `ALLOW_DEV_AUTH` | Must be `true` for `AUTH_MODE=dev` (the identity picker, where the browser chooses its own identity, admin included). `npm run dev` sets it. Never allowed with `NODE_ENV=production`. Dev mode listens on 127.0.0.1 only; `npm run dev:lan` also sets `DEV_LAN=true`. |
| `DB_SSL_CA` | Optional. A PEM (or a path to one) to trust for the database server. Without it Node's public root store is used, which is enough for Neon. TLS to any non-local database is always on and always verified, whatever the URL's `sslmode` says. |
| Times | Every time shown or typed is Windhoek time (CAT, UTC+2), converted in `client/src/windhoek.ts`. Times are stored as UTC instants. Voting cut-offs and closing times are judged by the database clock. |
| Request logs | The Worker's per-request log lines are switched off (`observability.logs.invocation_logs: false`): a ballot URL contains the share token and would be logged with its exact time. Errors and console output are still logged, with tokens masked and accounts shown as a short one-way tag. |
| Allow edits after start | A per-campaign checkbox, off by default, set while the campaign is a draft. When on: title, description and closing time stay editable while it is open, and candidates can be added, edited or removed until the first vote is cast. Who can vote and the opening time stay locked. Every edit is an audit entry (`campaign.edit_after_start`) and shows as "Edited after start", with the time, on the campaign page, the ballot page and the published results. The database enforces the same limits (migration 012). |
| DEMO banners | None. The server still logs a warning at start-up and daily while `DEMO_MEMBER_EMAILS` is set. |
| Closing blocked | If receipts and the sum of the tallies ever disagree, the campaign is not closed (and a closed result that no longer matches its seal is not published) until the creator has looked into it and acknowledged it with a note (Results tab). |

## Deploying

`node scripts/cf-deploy.mjs` reads `worker/wrangler.jsonc` to find the auth mode and then requires and sends only the secrets that mode
needs (`entra`: `ENTRA_CLIENT_SECRET`; `demo`: `CF_ACCESS_AUD`, `DEMO_USERS`). It refuses to deploy a config that is not
`NODE_ENV=production` or that would run the dev identity picker, and it never generates a secret: a missing `DEMO_SESSION_SECRET` is an
error that tells you how to make one (a new value signs everyone out, so a person has to choose it). Optional `SESSION_SECRET_PREVIOUS`
and `CSRF_SECRET` are sent when present in `.env`.

## Deploying from GitHub Actions

Actions tab, **Deploy (manual)**, Run workflow on `main`, type `DEPLOY`. Nothing runs by itself. The workflow:

1. **Gate:** refuses unless it runs on `main`, you typed `DEPLOY`, and the CI workflow has a green run on this exact commit.
2. **One job:** preflight (every secret present, config safe) -> build the container image -> typecheck and build -> **snapshot of the
   live database** (a Neon branch, `scripts/neon-snapshot.mjs`) -> database migrations with the owner URL -> `scripts/cf-deploy.mjs`
   (Worker + Container, then secrets) -> smoke test (`GET /api/csrf` = 200). If the snapshot cannot be made, the deploy stops before
   the migration.
   A failure before the migration step leaves everything as it was. The only gap is between the migration and the new container
   answering (a few minutes): the old app cannot work against the new schema, so do not run it during a vote.

Repository secrets (Settings -> Secrets and variables -> Actions -> New repository secret):

| Secret | How to get it |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard -> Workers & Pages -> right-hand side "Account ID". |
| `CLOUDFLARE_API_TOKEN` | Cloudflare -> My Profile -> API Tokens -> Create Token (custom). Permissions: Account / Workers Scripts: Edit, Account / Cloudflare Containers: Edit (needed to push the image), Account / Workers R2 Storage: Edit. Scope it to this account only. |
| `DEMO_OWNER_DATABASE_URL` | Neon console -> project -> Connect -> role `neondb_owner` (or the owner role), the **pooled-off / direct** connection string, `?sslmode=require`. Used only for migrations. |
| `DEMO_DATABASE_URL` | Neon console -> Roles -> `namra_app` -> **Reset password**, then build `postgres://namra_app:<new password>@<host>/<db>?sslmode=require` (same host and database as the owner URL). Reset it right before you run the deploy: the live app keeps using the old password until the deploy sets this one. |
| `DEMO_SESSION_SECRET` | A fresh value: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`. Changing it signs everyone out (once). Keep a copy in your password manager; losing it only means another sign-out. |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Cloudflare -> R2 -> Manage API tokens -> Create API token, Object Read & Write on the `namra-voting-photos` bucket. |
| `R2_ENDPOINT` | Same page: `https://<account id>.r2.cloudflarestorage.com`. |
| `ENTRA_CLIENT_SECRET` | Entra admin centre -> App registrations -> the app -> Certificates & secrets -> New client secret. Copy the **Value** (not the Secret ID) immediately. Then set `ENTRA_SECRET_EXPIRES_AT` in `worker/wrangler.jsonc`. |
| `NEON_API_KEY` | Neon console -> Account settings -> API keys -> Create. Used only to create the pre-deploy snapshot branch (and to delete snapshots older than the last 3). **Required**: without it the deploy stops before migrating. |
| `NEON_PROJECT_ID` | Neon console -> project -> Settings -> General -> Project ID. Recommended (otherwise the project named `namra-voting-demo` is used). |
| `SESSION_SECRET_PREVIOUS`, `CSRF_SECRET` | Optional. Only for rotating the session secret without signing people out, or to give CSRF its own key. Leave unset otherwise. |

The workflow never prints a secret. It takes the app role's password from `DEMO_DATABASE_URL` for the migration runner
(only used on a brand-new database), so there is no separate secret for it.

## Temporary demo sign-in while the Entra secret is expired (since 15 Nov 2026; replaced by the switch-back below once `entra-return` is deployed)

**Why:** the Entra client secret expired (`AADSTS7000222`) over a weekend, so nobody could sign in with Microsoft. The live site runs a
**demo-only** sign-in until a new secret can be made. Part B and the positions work were **not** deployed: the live code is still the
pre-Part-B code (database at migration 012).

1. **15 Nov, 00:12 UTC:** `AUTH_MODE=demo`. Cloudflare Access sent an email code, and the app trusted the Access identity.
2. **15 Nov, 08:10 UTC:** `AUTH_MODE=email-demo`. The site has its own sign-in page. The Access app was removed (its settings are below,
   to restore it). The two admin accounts also needed a demo admin password.
3. **15 Nov, 08:31 UTC:** the admin password was removed on request. Every allowed address, the admins included, signs in with just the
   email.

> **What email-demo does and does not prove.** The person types an email address and is signed in as that address. **No code is sent,
> so nothing checks that the address is theirs.** Anyone who knows a NamRA address can sign in as that person, and vote as them in a
> vote open to all staff. (A vote for Umoja members also needs a member code, and only the two demo admins have one.) **There is no
> password for the admins either: anyone who types `lenton.losper@namra.org.na` or `llosperofficial@gmail.com` is a campaign admin.**
> They can see results once a vote closes, close, reset or publish votes, and change drafts. This is acceptable only for a demo with test
> data. It is **not** acceptable for a real election: switch back to Microsoft sign-in before one.

**What is live right now**

| What | Value |
|---|---|
| Code | Branch `demo-fallback`: the previous live commit `fdf5c98` plus the demo changes. Those changes are: an existing account keeps its id; the sign-in page forwards automatically; the container restarts when its settings change; and `AUTH_MODE=email-demo`. The branch is never merged. |
| Sign-in | `/login`: one email field and a Sign in button, with a "Demo sign-in" note. Only addresses ending `@namra.org.na`, plus the addresses in `DEMO_USERS`, are accepted, trimmed and lower-cased. There is no password for anyone, the admins included; a request that sends one is refused. There are 10 attempts a minute per client address. Every sign-in is in the audit log with its email (`auth.signin`). Sessions are the ordinary database sessions: staff 8 h idle, admins 4 h idle, 12 h at most. |
| Safety rails | The app refuses to start in email-demo when `NODE_ENV=production` unless `DEMO=true`. |
| Worker | `AUTH_MODE=email-demo`, `DEMO=true`; secret `DEMO_USERS`. `ADMIN_DEMO_PASSWORD` was deleted from the Worker, GitHub and `.env` on 15 Nov. `ENTRA_CLIENT_SECRET`, the other Entra vars and the old `CF_ACCESS_AUD` are still on the Worker, ignored. |
| People | `DEMO_USERS`: `lenton.losper@namra.org.na` and `llosperofficial@gmail.com` are admins (no password) and active members, with the test codes `TST0026` and `TST0027` (separate codes, so they are two voters). Every other `@namra.org.na` address is plain staff with no employee code. An address that already has an account keeps it, so Lenton keeps his Microsoft account `87a4af90…` and its campaigns. |
| Deployed | Deploy run `43694868659` from `demo-fallback` `1b994a6`, Worker version `cdc4860c…`; its smoke test passes (`/api/csrf` -> 200). Live checks passed: a non-NamRA address is refused; staff sign in; both admin addresses sign in with just the email as admins; a password in the request is refused; Lenton keeps `87a4af90…` and his 4 campaigns; sign-out revokes the session. Earlier: run `43693153455` (`3568c2c`, with the admin password), after which the Access app was deleted. |
| Rollback points | Neon branches `pre-deploy-2026-11-15T08-30-57-demofb-1b994a6` (`br-falling-smoke-baa4rv3z`, before the password was removed) and `pre-deploy-2026-11-15T08-09-06-demofb-3568c2c` (`br-still-sea-bail4p1k`, before email-demo). The snapshot script keeps the 3 newest. |
| GitHub secrets | `DEMO_USERS` (and the older `CF_ACCESS_AUD`), read by the Deploy workflow on `demo-fallback`. |

The Deploy run's smoke test passes again in email-demo (`/api/csrf` answers 200). It reported a failure only while Access was in front.

### The removed Cloudflare Access app (to restore it)

These are the exact settings, so it can be recreated (Zero Trust -> Access -> Applications -> Add -> Self-hosted, or the API, as below):

| Setting | Value |
|---|---|
| Name | NamRA Voting demo (temporary: Entra secret expired) |
| Type / domain | `self_hosted` on `namra-voting-demo.llosperofficial.workers.dev` |
| Identity provider | One-time PIN only (`745b0ddf-a2dc-4258-8889-98ffd628efe3`), "instant auth" on (`auto_redirect_to_identity: true`), not in the App Launcher |
| Session duration | `730h` (1 month) |
| Policy | "NamRA staff and the operator": **Allow**, include *Emails ending in* `namra.org.na` **or** *Email* `llosperofficial@gmail.com` |
| Team domain | `yellow-flower-4592.cloudflareaccess.com` |
| Old app id / aud | `809832ef-39c7-436a-b1f3-57bef669fd94` (deleted). A recreated app gets a **new** `aud`. |

To restore the Access-protected demo (AUTH_MODE=demo) instead of email-demo:

1. Recreate the app. Either use the console with the settings above, or `node scripts/cf-api.mjs POST /accounts/{acct}/access/apps body.json`
   with this `body.json`:
   ```json
   { "name": "NamRA Voting demo (temporary: Entra secret expired)", "type": "self_hosted",
     "domain": "namra-voting-demo.llosperofficial.workers.dev", "session_duration": "730h",
     "allowed_idps": ["745b0ddf-a2dc-4258-8889-98ffd628efe3"], "auto_redirect_to_identity": true, "app_launcher_visible": false,
     "policies": [{ "name": "NamRA staff and the operator", "decision": "allow", "precedence": 1,
       "include": [{ "email_domain": { "domain": "namra.org.na" } }, { "email": { "email": "llosperofficial@gmail.com" } }] }] }
   ```
2. Put the new app's `aud` into `.env` (`CF_ACCESS_AUD=`) and the GitHub secret: `gh secret set CF_ACCESS_AUD`.
3. On `demo-fallback`, set `"AUTH_MODE": "demo"` in `worker/wrangler.jsonc`. Wait for green CI, take a snapshot
   (`node scripts/neon-snapshot.mjs --label demo-back`), then run Deploy (manual) on `demo-fallback` with `DEPLOY`. While Access is in
   front, its smoke test reports 302 and fails; that is expected.

### Switching back to Microsoft sign-in (entra), step by step

**Status:** the code and configuration for the switch-back are on branch `entra-return` (`worker/wrangler.jsonc` says `AUTH_MODE=entra`; `DEMO` and `DEMO_MEMBER_EMAILS` are gone). **Nothing is live until the branch is merged to `main` and Deploy (manual) is run**, which the gate only allows from `main` with green CI.

> **This deploy is the whole of `main`, not only the sign-in change.** The live site still runs the pre-Part-B code at migration 012. A deploy from `main` also ships Part B, positions, the ballot redesign, results privacy, BASE_PATH and migrations 013 to 023 (019 rewrites the primary keys of `tallies` and `vote_receipts`). Read "Rolling back a deploy" below first, and do not deploy while a vote is open. The Deploy workflow takes the Neon snapshot before it migrates.

Do it outside a vote: the app restarts, so sign-in is interrupted for a few minutes.

1. **Make a new client secret.** Entra admin centre -> App registrations -> NamRA Voting (client id `281ab38e-9ff5-4f17-88ea-18bdc3e65457`) -> Certificates & secrets -> New client secret. Copy the **Value** (not the Secret ID) at once, and note the expiry date.
2. **Put it in `.env` as `ENTRA_CLIENT_SECRET=<value>`** (never in a file that is committed, and never in chat). Check it before using it:
   ```
   node --input-type=module -e "process.loadEnvFile('.env'); const m = await import('./scripts/monitor-lib.mjs'); console.log(await m.checkEntraToken({ tenantId: 'fe7b029e-7e19-4525-bdf4-57462a59d299', clientId: '281ab38e-9ff5-4f17-88ea-18bdc3e65457', clientSecret: process.env.ENTRA_CLIENT_SECRET }))"
   ```
   It must report ok (no `AADSTS` code). `AADSTS7000215` means the Secret ID was copied instead of the Value.
3. **Store it where the deploy and the monitor read it.**
   - `gh secret set ENTRA_CLIENT_SECRET` (paste the value): the Deploy workflow sends it to the Worker.
   - The expiry date, in **two** places: uncomment `"ENTRA_SECRET_EXPIRES_AT": "YYYY-MM-DD"` in `worker/wrangler.jsonc` and put the real date there (the app warns admins from it, 30 days before), and set the repository variable of the same name for the Monitor (`gh variable set ENTRA_SECRET_EXPIRES_AT --body YYYY-MM-DD`).
4. **Check the redirect URI is registered.** The app uses `PUBLIC_BASE_URL` + `BASE_PATH` + `/auth/callback`. For the live site that is `https://namra-voting-demo.llosperofficial.workers.dev/auth/callback` (already registered). For the VM it is the address in HOSTING.md.
5. **Merge and deploy.** After CI is green on `entra-return`, merge it to `main`, wait for CI on `main`, take a snapshot by hand (`node scripts/neon-snapshot.mjs --label entra-back`), then Actions -> **Deploy (manual)** -> Run workflow on `main`, type `DEPLOY`. It sets `AUTH_MODE=entra` and sends only `ENTRA_CLIENT_SECRET` (not `DEMO_USERS`, not `CF_ACCESS_AUD`). The smoke test must pass (`GET /api/csrf` -> 200). The container restarts when its settings change; if the site still shows the email sign-in page, run Deploy a second time.
6. **Tidy the Worker.** The demo-only secrets are unused in entra mode. From `worker/`, run `npx wrangler secret delete DEMO_USERS` and `npx wrangler secret delete CF_ACCESS_AUD`; delete the GitHub secrets `DEMO_USERS` and `CF_ACCESS_AUD` too (`gh secret delete ...`).
7. **Check it** (a phone test with your own account and a colleague's): the site goes straight to Microsoft sign-in, not the email page; sign in as lenton.losper@namra.org.na: same account (`87a4af90…`) and campaigns. Microsoft sign-in rewrites your name and employee code from the token, so the temporary `TST0026` disappears by itself. Accounts that email-demo created for other addresses stay in the database, unused; their sign-ins are in the audit log.
8. **Clean up the git side.** Delete the `demo-fallback` branch (`git push origin --delete demo-fallback`, and `git worktree remove ../UmonjaVoting-demo` where it was checked out), and the `pre-deploy-...-demofb-...` Neon branches once the switch-back has been verified.

If anything goes wrong in steps 5 to 7, roll back as described in "Rolling back a deploy" (the Worker's previous deployment in Cloudflare, and the pre-deploy Neon snapshot). The Deploy workflow only runs from `main`, so the old `demo-fallback` code can no longer be redeployed through it.

**What stays in the code.** `AUTH_MODE=email-demo` (and `demo`, `dev`) are still there but are **off**: nothing in production config selects them, `DEMO_MEMBER_EMAILS` needs `DEMO=true` (the app refuses to start otherwise), and the deploy sends no demo secrets in entra mode. To turn the typed-email demo on again (a demo only, never for a real vote): set `AUTH_MODE=email-demo` and `DEMO=true` in `worker/wrangler.jsonc`, put `DEMO_USERS` in `.env` and in GitHub, deploy. While it is on, admins see "Test mode: sign-in doesn't verify identity. Don't use for a real vote." on every list and Umoja campaign.

**The Monitor workflow.** Once the app reports `AUTH_MODE=entra`, the Monitor again tests the Microsoft redirect, exercises `ENTRA_CLIENT_SECRET` once an hour, and checks `ENTRA_SECRET_EXPIRES_AT`: a **warning** from 30 days before expiry, a **failure** in the last 7 days and after it. Without the date it warns that the expiry is not tracked.

### Who a person is, and voter lists (entra mode)

- **Address.** The person's address is the token's `email` claim, then its `mail` claim; `preferred_username` (the sign-in name, which can differ from the mail address) is used only when both are missing.
- **Account binding.** The first time a listed person signs in with Microsoft, their address on every voter list is bound to their account id (`eligible_voters.voter_oid`). From then on the account decides, not the address: a renamed account keeps its vote, and a different account that is later given the same address does not inherit it. Rows not yet bound are matched by address. Receipts (`vote_receipts.voter_oid`, member key `oid:<id>`) were already per account. Nothing is bound in the other modes (their accounts are not real Microsoft identities).
- **Warnings for admins.** Saving a list names the entries that are not email addresses (not saved) and the ones outside `@namra.org.na` (saved, flagged). The campaign page shows how many listed addresses have never matched a Microsoft account (with the addresses), and the SHA-256 fingerprint of the list.
- **The list of a started vote is locked by the database** (trigger on `eligible_voters`, migration 023), for every role. The only ways in are the creator's audited late add (`late_add_eligible`) and the retention job. The list fingerprint is in the audit entries `eligibility.set`, `campaign.start`, `voter.late_added` and `retention.purged`.
- **Leavers** (`npm run retention -- --leavers <file> --apply`): on a campaign that has started their address stays on the list, marked `left_at`, so the eligible count and quorum do not move; a draft's list simply loses it. One audit entry per campaign (`retention.leaver_marked` / `retention.leaver_removed`).

## Rolling back a deploy (pre-deploy snapshot)

Every deploy first creates a Neon branch of the live database **as of that moment**, named `pre-deploy-<UTC time>-<commit>`. It is a
copy-on-write fork: it takes seconds, has no compute attached, and costs almost nothing until it is used. The run's summary page names
it. The 3 newest snapshots are kept; older `pre-deploy-*` branches are deleted after a new one is made.

**Before the first deploy of Part B + positions (migrations 013 to 019)** this matters most: migration 019 rewrites the primary keys of
`tallies` and `vote_receipts` and moves every candidate into a position. Check in the run summary that the snapshot was made, and do not
deploy while a vote is open. To take one by hand first: `node scripts/neon-snapshot.mjs --label manual` (needs `NEON_API_KEY` in `.env`).

If the migration or the new app goes wrong:

1. **Stop new writes**: Cloudflare -> the Worker -> roll back to the previous deployment (Deployments tab), so the old code runs again.
2. **Restore the database**: Neon console -> Branches -> the live (default) branch -> **Restore** -> *From another branch* -> pick the
   `pre-deploy-...` branch of that run -> Restore. The live branch keeps its name, endpoint and connection strings, so the app reconnects
   with no configuration change. Neon keeps the replaced state as a backup branch (`<name>_old_<time>`) until you delete it.
3. Check it: `RESTORE_CHECK_URL=<owner URL> npm run restore:check` (migrations, audit chain, receipts = counters, sealed results).
4. Anything written between the snapshot and the restore is lost: votes, nominations and audit entries made after the deploy started.
   That is why a deploy must not run during a vote.

Alternatively, to inspect before restoring: add a compute endpoint to the snapshot branch in the Neon console and point
`npm run restore:check` at it. The snapshot branch itself is never changed by a restore.

## Matching Umoja members to Microsoft accounts

A name is not an identity, so matching is two steps and never writes to a database by itself:

1. `npm run umoja:match -- <HR export>` looks members up in Graph (device-code sign-in as you) and writes `data/umoja-match-report.csv`
   (gitignored: it is the only place names and emails are written). Each row shows the account found, how it matched (`exact_name` or
   `given_surname`) and, for ambiguous rows, every account that fits.
2. Open the report, check each row, and put `yes` in the `confirm` column of the rows that are right. Then
   `npm run umoja:match -- --apply-confirmed data/umoja-match-report.csv` writes the account id and email of the confirmed rows only.
   Ambiguous, not-found and conflicting rows can never be applied, even if marked `yes`.

## When sign-in stops working

A failed token exchange is logged with its Microsoft error code. `AADSTS7000222` (secret expired) and `AADSTS7000215` (secret invalid)
produce a clear line, for example `[entra] CLIENT SECRET EXPIRED (AADSTS7000222): ...`. Container log lines are not part of Workers Logs;
read them from the container's logs in the Cloudflare dashboard.

To fix an expired secret: create a new client secret in the Entra app registration, update the `ENTRA_CLIENT_SECRET` Worker secret
(`wrangler secret put ENTRA_CLIENT_SECRET`; no redeploy is needed), and set the new `ENTRA_SECRET_EXPIRES_AT`.

## Verifying a result

On a closed campaign, **Verify results integrity** (admin, Results tab) checks that the audit chain is intact, that the result was
sealed when the campaign closed, and that the counters and receipts still equal what was sealed. The fingerprint it shows is the
hash of the sealed entry: record it somewhere outside the database (for example in the minutes) to make later tampering detectable
even by someone with full database access.

## Sessions and exports

- **Sliding sessions.** Every request extends a session by its idle time (admins 4 h, staff 8 h), up to 12 h after sign-in. When one expires, the app clears the signed-in user and sends the browser to `/login?expired=1&next=<page>`, which goes to Microsoft without the account picker (`/auth/login?resume=1`), so people are usually signed straight back in. A vote in progress keeps its selection (sessionStorage, one use) and the ballot comes back with it selected; the person presses Cast vote again. If a re-sign-in was tried less than a minute ago the page shows the Sign in button instead of redirecting again.
- **Exports.** A closed campaign can be exported by its creator as CSV, Excel (.xlsx) or PDF (`/api/campaigns/:id/results.csv|xlsx|pdf`). Each download is audited (`results.export_csv|xlsx|pdf`) and any one of them counts as the copy required before a permanent delete. Open campaigns are refused (SEC-01). Spreadsheet text cells that would start a formula are prefixed with an apostrophe. The PDF header carries the NamRA logo (embedded from client/src/assets/namra-logo.jpg via server/src/services/logo.ts: regenerate that file when the logo changes; a test checks they match).

## Watching the Entra secret from outside

The *Monitor* workflow tests the client secret every hour and tracks its expiry date (set the repository variable `ENTRA_SECRET_EXPIRES_AT` to YYYY-MM-DD). It warns 30 days before and fails in the last 7 days and after expiry, naming Microsoft's code (`AADSTS7000222` = expired). When it fails: create a new secret in the Entra app registration (Certificates & secrets), then update `ENTRA_CLIENT_SECRET` as a Worker secret and as the GitHub repository secret, and update `ENTRA_SECRET_EXPIRES_AT` in both places. See `disaster-recovery.md`.
