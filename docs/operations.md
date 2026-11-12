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
