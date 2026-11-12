# Umoja Voting: security and business-logic audit

- **Scope:** whole repository at `bae447e` (main), static review. No application code was changed.
- **Date:** 2026-11-12
- **Method:** line-by-line read of `server/`, `worker/`, `client/`, migrations, Dockerfile and deploy scripts; `npm audit` (root and `worker/`: 0 vulnerabilities); the 9 DB-free unit-test files (121 tests, all passing). Three read-only Cloudflare API calls confirmed what is actually deployed (see section 4).
- **Threat actors considered:** NamRA staff member, campaign admin (creator), outsider holding the QR code, and someone with read access to the database or a developer `.env`.
- **Handle with care:** this report describes unpatched weaknesses. The GitHub repository is **public**, so this file should not be pushed until the top findings are fixed (see SEC-24).

"Exploitable now?" means: *yes* = reachable today with the access the actor already has; *conditional* = needs a data or config condition that may or may not hold; *theoretical* = needs a second bug or compromise I did not find.

---

## 0. Fix status

Updated as each phase lands. The detailed findings below are the original audit text and are not rewritten.

| ID | Status | Commit | Notes |
|---|---|---|---|
| SEC-01 | ✅ fixed | `cee80e3` | Turnout only while open; early close and reset need a reason, shown to voters and in published results; reset-round counts withheld until close; live per-candidate polling removed. |
| SEC-02 | ✅ fixed | `cee80e3` | Per-candidate tallies replace the ballots table (migration 007). Tally rows re-stamped after each vote and at close so no xmin matches a receipt. A shuffled/encrypted ballot box was not needed. |
| SEC-03 | ✅ fixed | `cee80e3` | Receipts carry member_key (oid-match, then employee code, then demo email) with UNIQUE (campaign, member_key) (migration 008). |
| SEC-04 | ◐ partly fixed | `cee80e3` | Done: final tallies sealed in a hash-chained audit entry, verify function, admin "Verify results integrity", sealed entry survives permanent delete. Remaining (Phase 2): export before permanent delete. |
| SEC-05 | ✅ fixed | `cee80e3` | campaign_voters snapshot (identities only) taken at start; eligibility checked against it (migration 009). |
| SEC-06 | ☐ open |  | Phase 2. |
| SEC-07 | ✅ fixed | `cee80e3` | Production refuses DEMO_MEMBER_EMAILS without DEMO=true; admin banner and log line while active. wrangler.jsonc now sets DEMO=true for the current demo deployment. |
| SEC-08 | ☐ open |  | Phase 2. |
| SEC-09 | ✅ fixed | `cee80e3` | Dockerfile on node:22-bookworm-slim (tag; not pinned by digest). |
| SEC-10 | ☑ accepted (owner decision) |  | Accepted by the owner (2026-11-12): no credential rotation or token scoping. |
| SEC-11 | ✅ fixed | `cee80e3` | ADMIN_OIDS added; email matching is the documented fallback (off once ADMIN_OIDS is set). The deployed config still uses ADMIN_EMAILS until ADMIN_OIDS is set (docs/operations.md). |
| SEC-12 | ☐ open |  | Phase 3. |
| SEC-13 | ☐ open |  | Phase 3. |
| SEC-14 | ☐ open |  | Phase 3. |
| SEC-15 | ☐ open |  | Phase 3. |
| SEC-16 | ☐ open |  | Phase 3. |
| SEC-17 | ☐ open |  | Phase 3. |
| SEC-18 | ☐ open |  | Phase 3. |
| SEC-19 | ☐ open |  | Phase 3. |
| SEC-20 | ☐ open |  | Phase 3. |
| SEC-21 | ☐ open |  | Phase 3. |
| SEC-22 | ☐ open |  | Phase 3. |
| SEC-23 | ☐ open |  | Phase 3. |
| SEC-24 | ☑ accepted (owner decision) |  | Owner decision (2026-11-12): the repository stays public for now. |
| SEC-25 | ☐ open |  | Phase 3. |
| SEC-26 | ☐ open |  | Phase 3. |

---

## 1. Summary table

| ID | Title | Severity | Area | File:line | Exploitable now? |
|---|---|---|---|---|---|
| SEC-01 | Creator sees live per-candidate tallies, can close early and reset repeatedly (result steering, small-count inference) | High | Integrity / secrecy | `routes/admin.ts:389`, `:315`, `:377`; `migrations/005:76` | yes (insider) |
| SEC-02 | A ballot can be linked to its voter through `xmin` / `ctid` | High | Ballot secrecy | `migrations/001:39-52`; `services/voting.ts:57-61` | yes (anyone with DB read) |
| SEC-03 | "One vote" is per Entra account, not per member | Medium | Voting integrity | `services/umoja.ts:15-32`; `migrations/001:39` | conditional |
| SEC-04 | No tamper-evident record of final results; creator alone can permanently delete them | Medium | Integrity / audit | `routes/admin.ts:365`; `migrations/005:42-68`; `services/campaigns.ts:22` | yes (insider) |
| SEC-05 | Umoja membership is live, not frozen when a campaign starts | Medium | Eligibility | `migrations/004`; `umoja/import.ts:22`; `services/umoja.ts` | yes (whoever runs the import) |
| SEC-06 | Stateless session cookie: no revocation, logout does not invalidate, one secret signs everything | Medium | Sessions | `auth/devAuth.ts:20-35`; `auth/signing.ts` | conditional |
| SEC-07 | `DEMO_MEMBER_EMAILS` override is live in committed production config and silent | Medium | Config | `worker/wrangler.jsonc:36`; `services/umoja.ts:25` | yes |
| SEC-08 | Unthrottled endpoints; any staff member can flood the audit log | Medium | Availability | `routes/admin.ts:24-32,106`; `auth/entra.ts:55,73` | yes |
| SEC-09 | Container base image is Node 20, past end-of-life | Medium | Dependencies | `Dockerfile:5,16,24` | theoretical |
| SEC-10 | Over-broad Cloudflare API token and all crown-jewel secrets in one local `.env` | Medium | Secrets | `.env` (not in repo); account config | conditional |
| SEC-11 | Admin role is granted by an email string, not by account id | Low | Authorisation | `auth/entra.ts:102`; `config.ts:84` | theoretical |
| SEC-12 | Signed sign-in-flow cookie is accepted as a session cookie | Low | Sessions | `auth/devAuth.ts:20-26`; `auth/entra.ts:65` | yes (limited effect) |
| SEC-13 | `dev` auth is the default; blocked only when `NODE_ENV=production`; server binds `0.0.0.0` | Low | Config | `config.ts:10,34-36`; `index.ts:13`; `auth/devAuth.ts:37-66` | theoretical (container) |
| SEC-14 | Logout is a GET and does not revoke the cookie | Low | CSRF / sessions | `auth/entra.ts:120-124` | yes |
| SEC-15 | CSRF token is not bound to the session or user | Low | CSRF | `auth/csrf.ts:15-37` | theoretical |
| SEC-16 | Integrity mismatch is detective only: campaign still closes and can be published | Low | Integrity | `services/campaigns.ts:15-24`; `routes/admin.ts:398` | theoretical |
| SEC-17 | SECURITY DEFINER functions trust the caller's `p_actor`; no DB-level state machine on `campaigns` | Low | Database | `migrations/005`; `migrations/003:15` | theoretical |
| SEC-18 | Vote time check uses the app clock; times are entered and shown in the browser's zone | Low | Time handling | `services/voting.ts:37`; `client/src/pages/admin/*.tsx` | theoretical |
| SEC-19 | Share token and voter id end up in logs | Low | Logging | `errors.ts:26`; `services/umoja.ts:51-53` | conditional |
| SEC-20 | Photo decoding allows 40 megapixels in memory on a small instance | Low | Uploads | `services/images.ts:17`; `routes/admin.ts:21` | yes (admin only) |
| SEC-21 | Bidi and control characters are not stripped from titles or candidate names | Low | Input | `domain/validation.ts:10-33` | yes (admin only) |
| SEC-22 | Entra-to-member matching is by name only | Low | Data quality | `umoja/match.ts:126-149,187` | conditional |
| SEC-23 | Deploy script forces unused secrets (`DEMO_USERS`, `CF_ACCESS_AUD`) and silently mints `DEMO_SESSION_SECRET` | Info | Deploy | `scripts/cf-deploy.mjs:13-18` | n/a |
| SEC-24 | Repository is public (deploy hostnames, tenant and client ids, admin email, full design) | Info | Exposure | `worker/wrangler.jsonc` | yes |
| SEC-25 | Worker only sets `X-Forwarded-*` when absent; client values pass through (nothing reads them today) | Info | Infra | `worker/src/forward.ts:12-13` | no |
| SEC-26 | `sslmode=require` semantics depend on the `pg` version | Info | Infra | `scripts/neon-setup.mjs:39` | no |

Verified-good items are listed in section 5 so the table above is not mistaken for the whole picture.

---

## 2. Findings

### SEC-01 (High): The creator can watch live tallies, close early and reset repeatedly

**What is wrong.**
- `GET /api/campaigns/:id/results` has no status check (`routes/admin.ts:389-396`). While voting is open the creator receives per-candidate counts and turnout, and can poll as often as the 60/min admin limit allows.
- `POST /:id/close` can be called any time, before `closes_at` (`:315`).
- `POST /:id/reset` works on open or closed campaigns, any number of times, with only a free-text reason of 10+ characters (`:377`, `migrations/005:76-121`). `/unarchive` removes the only other block (`:353`).
- The reset history is shown to voters only if results are published afterwards (`routes/vote.ts:112`), and reset entries do not appear anywhere while voting is open.

**How to exploit.**
1. Creator opens a campaign with candidates A and B, and watches the live counts.
2. Suppose the creator prefers A and B is ahead. They either reset ("Ballot design error, revoting") and extend `closes_at`, or, if A happens to be ahead, close immediately. Repeat until the preferred candidate leads, then close and publish.
3. Small-count inference: poll every second. Each increment of a candidate's count is one vote. If the creator knows one colleague voted in that second (they are standing beside them, or only 2-3 people have voted), they know the choice.

**Impact.** The election outcome can be steered by one insider and the secret ballot is weakened for anyone whose vote timing is observable. Each reset leaves an audit row with the previous tallies, but voters and leadership never see it unless someone queries the audit log.

**Fix.**
- Return only turnout (never per-candidate counts) while a campaign is open; show tallies only after `closed`.
- Suppress tallies if fewer than a minimum number of ballots exist (for example fewer than 5).
- Reset: allow only before the first vote, or require a second admin to co-approve; announce any reset to eligible voters on the ballot page immediately.
- Early close: require a reason, show it to voters, or disallow before `closes_at` unless every eligible voter has voted.
- Audit every read of live results (`results.view`).

**Test.** Integration: open campaign with 3 ballots, admin `GET /results` returns no per-candidate `votes` (only `turnout`) until status is `closed`; a reset after the first ballot is rejected or needs a second admin; the ballot page shows a reset banner.

---

### SEC-02 (High): A ballot is linkable to its voter through `xmin` and `ctid`

**What is wrong.** The receipt and the ballot are inserted in the same transaction (`services/voting.ts:57-61`). Every Postgres row carries hidden system columns: `xmin` (the inserting transaction id) and `ctid` (physical position). Both rows of one vote share the same `xmin`, and rows land in the heap in insertion order. The code and schema comments state that the two tables "share no column, no timestamp and no ordering key" (`voting.ts:19-21`, `001_schema.sql:38-45`); that is true of declared columns but not of these.

**How to exploit.** Anyone who can run a `SELECT` against the database: the app role `namra_app` (it has `SELECT` on both tables, `003:18-19`), the Neon owner, a Neon console user, or anyone with a backup or branch:

```sql
SELECT r.voter_oid, b.candidate_id
FROM vote_receipts r JOIN ballots b
  ON b.campaign_id = r.campaign_id AND b.xmin::text = r.xmin::text;
```

I did not run this (static review, no DB access used), but it is standard Postgres behaviour. After an autovacuum freeze `xmin` is replaced, but on a small database that takes a very long time; `ctid` ordering and the primary-key order of receipts versus ballots remain correlated for much longer. Cloudflare request logs (timestamp of every `POST /api/vote/<token>`) add a third correlation source for vote order.

**Impact.** Anyone with database read access can reveal how every member voted. The in-app guarantees (no candidate in the audit log, no logging of the body) do not help against a database reader.

**Fix.** Make the link structurally impossible rather than hidden:
- Write receipts immediately, but insert ballots in a *separate, later* transaction in random order and in batches (a queue table, drained by a job that shuffles). Keep ballots and receipts out of the same transaction and heap order.
- Or hold ballots in an encrypted ballot box with a key not available to the DB role.
- Also revoke `SELECT` on `ballots`/`vote_receipts` from the app role where possible (use aggregates through a function), and limit who holds the owner URL.
- Document the residual trust assumption for the DB operator.

**Test.** Integration: cast N votes in one session, then assert that no pair (receipt, ballot) can be matched by `xmin`, `ctid` or insertion order, for example by checking the queue/shuffle design inserts ballots in a different transaction and that `ballots.xmin` differs from every receipt's `xmin`.

---

### SEC-03 (Medium): One vote per Entra account, not per member

**What is wrong.** `vote_receipts` is keyed by `(campaign_id, voter_oid)` (`001:39-43`). Membership is established by any of three routes (`services/umoja.ts:15-32`): the account's `oid` matches `umoja_members.entra_oid`; the account's `employeeId` (copied to `users.employee_code` at sign-in) matches an active member's code; or the email is in `DEMO_MEMBER_EMAILS`. Nothing stops two accounts from resolving to the same member.

**How to exploit.**
1. A member holds two Entra accounts (for example a normal account and an admin or test account), and IT has set the same `employeeId` on both. Or IT mis-keys one `employeeId`.
2. Both accounts sign in, both pass the `employee_code` route, each casts a ballot. Two votes, one human.
3. A member whose `oid` was matched by name *and* a second account carrying the same code also gets two votes.

**Impact.** Double voting, undetectable afterwards because receipts carry only the account id.

**Fix.** Resolve every voter to one canonical member key inside the vote transaction (the matched `employee_code`), store it on the receipt, and add `UNIQUE (campaign_id, member_code)`. The receipt still has no candidate, so secrecy is unchanged. Reject sign-in-time `employeeId` values that collide with another user's code.

**Test.** Integration: two users with the same `employee_code`, both active members: the second `POST /api/vote/:token` returns 409 `already_voted`. Also: user matched by `oid` plus another user carrying the same code.

---

### SEC-04 (Medium): No tamper-evident record of final results

**What is wrong.**
- Closing writes only counts of ballots and receipts to the audit log (`services/campaigns.ts:22`), not the final per-candidate tallies. Resets do snapshot tallies, but a normal close does not.
- A campaign's creator can archive then `permanent-delete` it (`routes/admin.ts:339-374`, `migrations/005:42-68`), which removes ballots and receipts; the audit entry keeps only counts. There is no retention hold, no second approver, no export requirement first.
- `audit_log` is append-only for the app role, but it is not hash-chained, and the owner role (held on developer PCs) can edit anything.

**How to exploit.** A creator who dislikes a published result archives and permanently deletes the campaign. No record of who won survives except what members screenshotted. A DB owner can silently edit ballots or the audit log after the fact.

**Impact.** Results cannot be independently verified or defended later.

**Fix.** At close, write the final tallies and turnout into the audit log; hash-chain audit rows (each row stores a hash of the previous); export results plus the audit trail before permanent deletion is allowed; require a second admin for permanent deletion; keep a retention hold (for example 12 months) before deletion is possible.

**Test.** Integration: after close, `audit_log` contains a `campaign.close` row with per-candidate tallies; permanent delete is refused until an export exists or until a second admin approves; tampering with an audit row breaks chain verification.

---

### SEC-05 (Medium): Eligibility is not frozen when a campaign starts

**What is wrong.** For `umoja` campaigns eligibility is evaluated live against `umoja_members` on every request and vote (`services/umoja.ts:15-32`). A re-import (`umoja/import.ts:22` deletes members missing from the new file; inserts new ones) or a re-match changes who can vote in every running campaign. Draft-only locking (`inDraftTx`, trigger `002`) applies to candidates and `eligible_voters`, not to the member table. The eligible count shown to the creator also moves.

**How to exploit.** Whoever runs `npm run umoja:import` against the database (HR or IT, holding the owner URL) mid-campaign can add accounts that then vote, or remove members who have not yet voted. Either changes the outcome and leaves only a counts-only audit row (`umoja.import`).

**Fix.** Snapshot eligible members into `eligible_voters`-style rows at `start` and read only the snapshot; refuse imports while any umoja campaign is open (or apply them with an effective-from date).

**Test.** Integration: start campaign, import a file that adds member X and removes member Y; X still cannot vote and Y still can.

---

### SEC-06 (Medium): Stateless session cookie

**What is wrong.**
- The session is an HMAC-signed JSON blob in a cookie (`auth/devAuth.ts:28-35`), valid 8 hours. There is no server-side session record, so logout only asks the browser to delete it; a copied cookie stays valid until expiry (`auth/entra.ts:120-124` also does not revoke).
- Roles and `employeeCode` are baked into the cookie, so removing someone from `ADMIN_EMAILS` or disabling their Entra account does not take effect for up to 8 hours.
- One `SESSION_SECRET` signs sessions, CSRF tokens and sign-in-flow cookies. If it leaks (for example `DEMO_SESSION_SECRET`/`SESSION_SECRET` in a `.env` on a developer PC), anyone can mint a valid admin session for any `oid` offline.

**Impact.** Delayed revocation; full admin takeover if the secret leaks.

**Fix.** Store sessions server-side (session id in the cookie, record in the DB with revoke on logout) or add a per-user `session_version` checked on every request; shorten the TTL for admins; derive separate keys per purpose with HKDF (`session`, `csrf`, `authflow`); keep the secret out of developer `.env` files.

**Test.** Integration: sign in, copy the cookie, call logout, replay the cookie: expect 401. Sign in as admin, remove the email from admin list and bump version: expect 403 on next call.

---

### SEC-07 (Medium): `DEMO_MEMBER_EMAILS` is live in production config

**What is wrong.** `worker/wrangler.jsonc:36` (committed) sets `DEMO_MEMBER_EMAILS` to a real staff address. I confirmed through the Cloudflare API that the deployed Worker has exactly this value. Any address listed counts as an active Umoja member regardless of the HR list (`services/umoja.ts:25`). The only trace is a server-log line (`:26`); there is no startup warning, no admin-UI indicator and no audit entry. The same address is also in `ADMIN_EMAILS`.

**How to exploit.** Not an external attack: this is a way for a real election to be run with an unlisted member who can vote, or for the override to be forgotten when the app moves from demo to real use.

**Fix.** Refuse to start with a non-empty `DEMO_MEMBER_EMAILS` unless an explicit `DEMO_MODE=true` is also set; show a visible banner on every page while the override is active; remove the value from `wrangler.jsonc` and keep it in secrets only for the demo deployment.

**Test.** Unit: `parseConfig` with `NODE_ENV=production`, `AUTH_MODE=entra` and a non-empty `DEMO_MEMBER_EMAILS` but no `DEMO_MODE` throws.

---

### SEC-08 (Medium): Unthrottled endpoints and audit-log flooding

**What is wrong.**
- `requireAdmin` runs *before* `adminLimiter` (`routes/admin.ts:106`), and each non-admin hit writes an `authz.denied` audit row (`:27`). Any signed-in staff member can loop on `/api/campaigns/mine` and grow `audit_log` without limit (and force a DB write per request).
- `/auth/login`, `/auth/callback`, `/api/csrf` and `GET /api/vote/:token` have no limiter. The callback makes an outbound token request to Microsoft for every request that carries a valid sign-in-flow cookie, and `/auth/login` mints such cookies for free (`entra.ts:55-71`, `:73-88`). `GET /api/vote/:token` runs a write transaction (`refreshStatus`) on every call (`routes/vote.ts:20-25`).
- The vote limiter is in memory and resets on restart (single instance, by design).

**How to exploit.** Authenticated staff script `GET /api/campaigns/mine` in a loop: audit table and DB load grow, degrading voting during an election. An outsider can hammer `/auth/callback` with garbage codes to burn the app's Microsoft token quota.

**Fix.** Apply a limiter before `requireAdmin`, keyed by `oid`, and rate-limit or sample `authz.denied` rows; add IP and global limits on `/auth/*` and `/api/csrf`; make `refreshStatus` conditional (only when `closes_at` has passed).

**Test.** Integration: a non-admin session sending 200 requests in a minute receives 429 and creates far fewer than 200 audit rows.

---

### SEC-09 (Medium): Node 20 base image is past end-of-life

**What is wrong.** All three Dockerfile stages use `node:20-bookworm-slim` (`Dockerfile:5,16,24`). Per Node's published schedule, Node 20 reached end-of-life in April 2026, so it no longer receives security fixes. Tags are not pinned by digest.

**Fix.** Move to the current LTS (22 or later), pin by digest, and rebuild regularly.

**Test.** CI check that fails if the base image's Node major is not in the supported list.

---

### SEC-10 (Medium): Over-broad Cloudflare token and a `.env` full of crown jewels

**What is wrong.** The API token in `.env` could list every Worker in the account, including unrelated products (staging and production workers). I did not test write access. The same `.env` holds the Neon API key, the Neon owner connection string, R2 keys, the Entra client secret and the session secret. The secrets were also pasted into an AI chat session during this work. A lost laptop or leaked `.env` gives full control of the database and every Worker the token covers.

**Fix.** Scope the Cloudflare token to this one Worker, its Durable Object/container and the one R2 bucket; use a bucket-scoped R2 key; keep the Neon owner URL out of everyday `.env` files (use it only for migrations, from a protected machine or CI). Rotate the credentials that have been pasted into chats.

**Test.** Manual: `GET /accounts/{id}/workers/scripts` with the deploy token must fail for other scripts.

---

### SEC-11 (Low): Admin by email string

`admin = roles.includes('CampaignAdmin') || adminEmails.includes(email)` (`auth/entra.ts:102`), where `email` is `preferred_username` or `email` from the ID token. If a UPN is renamed or reused for a different person, that person becomes admin. Entra admins (not ordinary users) can change these attributes, so exploitation needs IT-level access: theoretical. **Fix:** list admin `oid`s, or require the app role only. **Test:** unit: a token whose `preferred_username` equals an admin email but whose `oid` is not listed is not admin.

### SEC-12 (Low): Auth-flow cookie accepted as a session

`sign()` uses the same key and no type tag for the session cookie and the `namra_auth_<state>` cookie (`entra.ts:65`). `getCurrentUser` only checks that `exp` is a number (`auth/devAuth.ts:20-26`), so a signed sign-in-flow cookie renamed to `namra_session` yields a "user" whose `oid`, `email` and `roles` are `undefined`. `requireUser` passes. In practice the handlers then throw (`roles.includes`, `email.toLowerCase`) and the vote insert hits a NOT NULL violation, so I found no privilege gain; but it is an unintended state any anonymous visitor can reach. **Fix:** add a `typ` field to every signed payload and validate the session payload shape (zod) with a UUID `oid`. **Test:** unit: `verify` of an auth-flow token as a session returns null.

### SEC-13 (Low): `dev` auth is the default

`AUTH_MODE` defaults to `dev`; it is refused only when `NODE_ENV=production` (`config.ts:34-36`). In dev, `POST /api/dev/login` lets the *client* assert its own `roles: ['CampaignAdmin']` (`auth/devAuth.ts:41,50-66`), and `index.ts:13` always listens on `0.0.0.0`. The container is protected because the Dockerfile sets `NODE_ENV=production` and the Worker config pins `AUTH_MODE=entra`. On any other host where `NODE_ENV` is forgotten, or on a LAN, that is full admin takeover. **Fix:** require an explicit `ALLOW_DEV_AUTH=1` and bind to `127.0.0.1` unless `--lan`. **Test:** unit: `parseConfig({})`-style env with no `NODE_ENV` and no `ALLOW_DEV_AUTH` throws.

### SEC-14 (Low): GET logout

`GET /auth/logout` clears the session and redirects to Microsoft sign-out (`entra.ts:120-124`). Any page can embed `<img src="/auth/logout">` to log a visitor out (nuisance only). **Fix:** make it POST with CSRF, or accept the nuisance. **Test:** `GET /auth/logout` with no CSRF does not clear the cookie.

### SEC-15 (Low): CSRF token not bound to the user

The token is `nonce.HMAC(nonce)` and anyone can mint one from `GET /api/csrf` (`auth/csrf.ts:15-37`); protection rests on `SameSite=Strict` and on attackers being unable to set cookies for the host. On `*.workers.dev` (a public-suffix domain) sibling Workers cannot, so this is theoretical today; on a custom domain with other subdomains it is not. **Fix:** include the session `oid` in the MAC. **Test:** a token minted before sign-in is rejected after sign-in.

### SEC-16 (Low): Integrity mismatch is only recorded

`closeInTx` logs `campaign.close.INTEGRITY_MISMATCH` when ballots != receipts but still closes, and nothing blocks publishing or alerts anyone (`services/campaigns.ts:15-24`, `routes/admin.ts:398`). Only DB-level tampering can cause it. **Fix:** block publish on mismatch, show a red banner, send an alert. **Test:** insert a stray ballot as owner, close, publish: expect 409.

### SEC-17 (Low): Definer functions and DB-level rules

The three SECURITY DEFINER functions pin `search_path = public, pg_temp`, validate state, and have `PUBLIC` revoked (good). But `p_actor` is supplied by the caller, so the app role can pass any creator's id; and `namra_app` has `UPDATE` on all columns of `campaigns` (`migrations/003:15`), so status can be reversed or `created_by` changed with no trigger. Exploitation needs an app compromise or SQL injection, and I found no injection. **Fix:** a trigger enforcing the status state machine and immutability of `created_by`; column-level grants. **Test:** as `namra_app`, `UPDATE campaigns SET status='draft'` on a closed campaign fails.

### SEC-18 (Low): Time handling

Vote acceptance uses the container's `new Date()` (`services/voting.ts:37`) while reset and DB constraints use `now()`; skew between them is small but unbounded. Admins type times in `datetime-local` fields and the browser converts with its own zone (`new Date(x).toISOString()`); voters see times in their browser zone with no zone label. Namibia is UTC+2 with no daylight saving, so mistakes come from wrongly configured devices, not DST. **Fix:** use `now()` inside the vote transaction; show "CAT (UTC+2)" next to every time and convert explicitly. **Test:** unit: a campaign closing at 17:00 CAT closes at 15:00 UTC regardless of browser zone.

### SEC-19 (Low): Share token and voter id in logs

The central error handler logs `req.path` (`errors.ts:26`), which for vote routes contains the campaign share token. `logNotMember` logs the voter's `oid` with the campaign id (`services/umoja.ts:51-53`), and Workers Logs record every request URL at 100% sampling. No candidate id appears anywhere (good). Share tokens only matter together with eligibility, so impact is low; but the access link should not sit in logs. **Fix:** log a route pattern, not the path; log a hashed oid. **Test:** unit: error handler output for `POST /api/vote/<token>` contains no token.

### SEC-20 (Low): Image decode limits

`sharp(buf, { limitInputPixels: 40_000_000 })` decodes up to 40 megapixels (about 160 MB raw) in memory per upload, with `multer` memory storage (`images.ts:17`, `admin.ts:21`). On the `basic` container a few concurrent uploads could exhaust memory. Only admins can upload. **Fix:** lower to about 12 MP; serialize image processing. **Test:** a 30 MP PNG is rejected with 400.

### SEC-21 (Low): Unicode controls in names

Titles, descriptions, candidate names and bios are trimmed and length-checked but not stripped of bidi overrides (U+202A-202E, U+2066-2069) or zero-width characters (`domain/validation.ts:10-33`). An admin could display a candidate name that renders differently from its stored value. React escapes HTML, so this is display spoofing, not XSS. **Fix:** strip those code points with `.transform`. **Test:** unit: a name containing U+202E is rejected or stripped.

### SEC-22 (Low): Member matching by name only

`matchMembers` pairs HR names to Entra accounts by given name and surname (`umoja/match.ts:126-149`) and `applyMatches` silently moves an account to a new code (`:187`). Ambiguity and double-claims are rejected, which is good, but a single unrelated namesake in the directory is accepted as "matched", giving that person voting rights while the real member is shown `not_member`. **Fix:** require a second identifier (department, job title or an HR-supplied mail) and a human review of the report before `--apply`. **Test:** unit: a member whose only Graph hit has a different department is `ambiguous`.

### SEC-23 (Info): Deploy script

`cf-deploy.mjs:13` requires `DEMO_USERS` and `CF_ACCESS_AUD` even though `AUTH_MODE=entra` never reads them, and sends them (plus the rest) to the container. If `DEMO_SESSION_SECRET` is missing it generates one and appends it to `.env` (`:15-18`), which logs everyone out on that deploy. The Worker pins `NODE_ENV=production` and `AUTH_MODE=entra` in `wrangler.jsonc`, so the script cannot deploy dev settings. **Fix:** only require what the mode needs; print a notice when a secret is generated.

### SEC-24 (Info): Public repository

`Lenton-Losper/Namravoting` is public. It exposes the deploy hostname, Entra tenant and client ids, the admin email, the full schema and the exact secrecy design. None is a credential, but it makes targeting easier and means **this report must not be pushed as is**. My history scan (regex for Neon/Cloudflare/Entra/R2 secret shapes over all 12 commits) found no real secret; one test fixture contains a fake password. **Fix:** make the repo private, or push this report to a private location.

### SEC-25 (Info): Forwarded headers

`worker/src/forward.ts:12-13` sets `X-Forwarded-Host`/`-Proto` only when missing, so a client can supply them. A grep of the server shows no use of `X-Forwarded-*`, `req.hostname`, `req.protocol` or `trust proxy`; redirect and base URLs come from config. No impact today. **Fix:** always overwrite. **Test:** unit: `toContainerRequest` replaces a client-supplied `x-forwarded-host`.

### SEC-26 (Info): TLS setting

Neon URLs use `sslmode=require`. With the installed `pg`, this currently means certificate verification, but that meaning is scheduled to change to libpq semantics (encryption without verification). **Fix:** set `sslmode=verify-full` explicitly.

---

## 3. Business-logic gaps

| Topic | Status | Notes |
|---|---|---|
| Abstain / "none of the above" | **Missing** | Ballot must name a candidate (`voteBody`). |
| Ties | **Partly** | Dashboard flags `tie` for a winner (`admin.ts:147`); no tie-break or run-off rule, results page and CSV do not flag it. |
| Candidate withdraws mid-vote | **Missing** | Candidates are locked once a campaign leaves draft (trigger `002`); the only option is reset (which keeps candidates) or a new campaign. |
| Min / max candidates | **Partly** | Minimum 2 enforced at start (`admin.ts:299`); no maximum; no minimum turnout or quorum. |
| Several admins co-managing a campaign | **Missing** | Single `created_by` owner; every route checks it. |
| Observers / auditors with read-only access | **Missing** | Only creator-admin and voter roles exist. |
| Who publishes results and when | **Partly** | Creator publishes manually after close; no schedule, no second approver, no unpublish except by reset. |
| Notifying staff | **Missing** | QR, poster and WhatsApp link only; no email/Teams, no reminders. |
| Staff leaving or joining mid-campaign | **Partly** | Membership is live (SEC-05): joiners can vote once imported; leavers keep access until their Entra account is disabled and their 8-hour session ends (SEC-06). |
| Updating the member list | **Partly** | Local script only; remote import needs `--allow-remote`; no diff preview, no approval, counts-only audit. |
| Retention and deletion policy | **Partly** | Creator can permanently delete archived campaigns; no retention period, `users` and `audit_log` rows are kept forever with no deletion path for leavers; database backups keep deleted ballots for the backup window. |
| Accessibility | **Unknown** | Not tested; the client has some `aria-` attributes (about 27) but no automated accessibility test. |
| Offline / poor signal | **Partly** | Retry UI exists (commit `c131a9e`); no offline queue. A lost response after a successful vote shows "already voted", which is correct but confusing. |
| Entra secret expiry (today's incident) | **Missing** | No expiry tracking, no health check, no alert. Users see a generic `signin_failed`; the real AADSTS code is only in container logs, which are not in Workers Logs. |
| Backup and restore | **Unknown / missing** | Relies on Neon point-in-time recovery; retention and a tested restore were not verified; no results export. |
| Disaster recovery for the single container | **Partly** | Container is stateless and restarts on the next request; `max_instances: 1`, single region, 50 s cold-start budget, no uptime monitoring or runbook. |
| Audit export for Umoja leadership | **Partly** | Results CSV after close (`candidate,votes,total`); no audit-log export, no turnout vs eligible, no integrity statement, reset history only visible after publish. |

---

## 4. Couldn't verify

- **DB-backed tests:** the 11 integration test files need Postgres on port 5433 and Docker is not installed on this PC. Only the 9 unit-test files ran (121 tests, all passed). Everything about transactions, locking (`FOR SHARE` vs `FOR UPDATE`), serialization retries, grants and the `xmin` linkage comes from reading the SQL, not from running it.
- **Live Neon database:** actual role grants, PITR retention, TLS enforcement, project members, whether `namra_app` holds extra privileges. I did not connect to the database.
- **Cloudflare:** WAF and rate-limit rules, token permissions (write access), R2 key scope. Confirmed read-only through the API: the R2 bucket has its public `r2.dev` domain disabled and no custom domains; the deployed Worker's plain variables and secret *names* match the repo (`DEMO_MEMBER_EMAILS` and `ADMIN_EMAILS` are set; `NODE_ENV=production`, `AUTH_MODE=entra`). Secret values were not read.
- **Entra app registration:** redirect URIs, "assignment required", guest access, whether `employeeId` is populated or editable, secret expiry date, token claims.
- **Container logs:** not reachable from Workers Logs, so the exact `[entra] sign-in rejected` line from the 12 Nov incident was not seen.
- **Browser runtime:** no browser testing; XSS review is static (React escaping, no `dangerouslySetInnerHTML`/`innerHTML`, strict CSP).
- **Secret scan:** regex scan of 12 commits, not a full scanner such as gitleaks.
- **Concurrency races** were reasoned about, not exercised.
- **Accessibility, load and performance** were not assessed.

---

## 5. Checked and found sound

- **State, nonce and PKCE** are generated per attempt and verified twice (library and code); ID token signature, issuer, audience and `tid` are checked; the redirect URI is fixed in config; per-attempt cookies are capped at 6, expire after 10 minutes, are single-use and are pruned (`entra.ts`).
- **CSRF** covers every state-changing `/api` route including delete, archive, unarchive, reset, permanent delete; `/auth/*` has no state-changing POST.
- **Authorisation:** every `/api/campaigns/:id/*` route goes through `loadOwned` (creator check, 404 for non-owners, audited); list and summary routes filter by `created_by`; vote and photo routes re-check eligibility on every call; no uncovered route found.
- **`safeNext`** rejects `//`, backslashes, control characters, absolute URLs and anything outside `/v/`, `/votes`, `/admin`; the client copy is identical.
- **SQL:** all queries are parameterised; the only string-built SQL is the `DEMO_MEMBER_EMAILS` array, which is validated to plain email characters and quote-escaped.
- **Uploads:** magic-byte check, sharp re-encode to JPEG (metadata dropped), 2 MB limit, random file names, key pattern checked on every read and delete, authenticated photo route.
- **Headers and cookies:** strict CSP (`default-src 'none'`, no inline script or style), `frame-ancestors 'none'`, HSTS in production, `HttpOnly`, `Secure` in production, `SameSite=Strict` (Lax only on the sign-in-flow cookie).
- **Vote atomicity:** receipt and ballot in one serializable transaction; candidate must belong to the campaign (composite foreign key); `FOR SHARE` vs `FOR UPDATE` orders vote against close and reset.
- **Definer functions:** `search_path` pinned, `PUBLIC` revoked, creator and state re-checked inside.
- **CSV export** neutralises leading `= + - @ tab CR`.
- **Dependencies:** `npm audit` reports 0 vulnerabilities for the app and for `worker/`; Docker builds use `npm ci` against the lockfile.
- **R2:** bucket not publicly exposed; SigV4 signing implementation matches the documented scheme.

---

## 6. Top 5 to fix before a real election

1. **SEC-01:** hide per-candidate counts until close, add a minimum-count threshold, and restrict reset and early close (second admin, voter-visible notice).
2. **SEC-02:** break the receipt-to-ballot link at the storage level (separate transactions, shuffled batch insert, or an encrypted ballot box) and restrict who can read both tables.
3. **SEC-03:** key the one-vote rule on the canonical member (employee code) with a database unique constraint.
4. **SEC-05 and SEC-04:** snapshot eligible members at start, and record final tallies in a hash-chained audit log before any deletion is possible.
5. **Go-live gate:** remove `DEMO_MEMBER_EMAILS` (SEC-07), move admins to `oid`s (SEC-11), scope and rotate the Cloudflare and Neon credentials (SEC-10), upgrade the base image (SEC-09), and add Entra secret expiry monitoring with an alert (section 3).
