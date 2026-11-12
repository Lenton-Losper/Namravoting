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
