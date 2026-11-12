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
| `SESSION_SECRET_PREVIOUS` | Optional. The old `SESSION_SECRET` during a rotation: accepted for verifying cookies only, never for signing. Remove it once old cookies have expired (admin sessions last 4 hours, staff 8). |
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
2. **One job:** preflight (every secret present, config safe) -> build the container image -> typecheck and build -> database
   migrations with the owner URL -> `scripts/cf-deploy.mjs` (Worker + Container, then secrets) -> smoke test (`GET /api/csrf` = 200).
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
| `SESSION_SECRET_PREVIOUS`, `CSRF_SECRET` | Optional. Only for rotating the session secret without signing people out, or to give CSRF its own key. Leave unset otherwise. |

The workflow never prints a secret. It takes the app role's password from `DEMO_DATABASE_URL` for the migration runner
(only used on a brand-new database), so there is no separate secret for it.

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
