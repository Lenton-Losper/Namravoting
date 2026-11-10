# NamRA Staff Voting System (v1, auth stubbed)

Internal secret-ballot voting app. Admins create campaigns, add candidates, start the vote and share a link / printable QR poster. Staff vote once from their phones.

Monorepo: `server/` (Express + TypeScript + PostgreSQL) and `client/` (React + Vite).

## Setup on Windows

Prerequisites: **Node 20+**, **Docker Desktop** (running).

```powershell
copy .env.example .env      # then edit SESSION_SECRET (32+ chars)
docker compose up -d --wait # Postgres 16 on localhost:5433
npm install
npm run migrate             # applies server/migrations/*.sql (creates the restricted app DB role too)
npm run seed                # 2 admins, 5 staff, 1 draft campaign with 3 candidates
npm run dev                 # API on :3001, web app on http://localhost:5173
```

Open http://localhost:5173, pick a seeded identity (admins: Alice / Bruno; staff: five others).
Host port is **5433** (not 5432) so it does not clash with a local PostgreSQL install.

### Tests
```powershell
npm test      # needs the Docker DB running; rebuilds the namra_test database from the real migrations
```

### Production-style single process
`npm run build`, then `npm start -w server`: the API also serves `client/dist`. `AUTH_MODE=dev` with `NODE_ENV=production` **refuses to start**.

## How the secrecy and integrity rules are enforced

- `ballots` has only `id` (random uuid), `campaign_id`, `candidate_id`. No voter, timestamp or IP. `vote_receipts` has no candidate and no timestamp.
- One vote per person: primary key on `vote_receipts (campaign_id, voter_oid)`.
- Casting a vote is one `SERIALIZABLE` transaction (re-check open and eligible, insert receipt, insert ballot), retried up to 3 times on serialization failure. Duplicate gives 409.
- A composite foreign key makes a ballot's candidate belong to the same campaign. A trigger blocks candidate changes after start.
- The server connects as `namra_app`: INSERT/SELECT only on `ballots`, `audit_log`, `vote_receipts`. The owner role is used only by `migrate`/`seed`.
- Vote routes never log bodies; the audit log never records candidate ids for votes.
- Close writes a `count(ballots) = count(vote_receipts)` integrity result to `audit_log` (`campaign.close`, or `campaign.close.INTEGRITY_MISMATCH`).

## Swapping in Entra ID

Only the **`server/src/auth/`** module changes:

1. Add an OIDC implementation (authorization code + PKCE, tenant-restricted) in place of `auth/devAuth.ts`, exposing `getCurrentUser(req)` (returning `{ oid, email, displayName, roles }`, with `CampaignAdmin` taken from the app-role claim) and a `mount(app, config)` that registers the login callback and logout routes. It must upsert the row in `users` at sign-in.
2. In `auth/index.ts`, change `getCurrentUser()` to delegate to it and handle `AUTH_MODE=entra` in `mountAuth()`.
3. Delete `/api/dev/*` usage: the client `pages/Login.tsx` becomes a "Sign in with Microsoft" redirect.
4. Set `AUTH_MODE=entra` and the tenant/client settings in config.

Nothing in routes, services or the database changes. CSRF (`auth/csrf.ts`) is independent of the session mechanism.

## Security notes

Helmet with strict CSP (`default-src 'none'`, `frame-ancestors 'none'`), `Referrer-Policy: no-referrer`, nosniff. Session cookie is signed, HttpOnly, SameSite=Strict, Secure in production. Signed double-submit CSRF token on every state-changing request. zod on every body and param. Photos: 2 MB cap, magic-byte check (JPEG/PNG), re-encoded to JPEG at most 800px, random filename, stored in `UPLOAD_DIR` (outside any static folder), served only through `/api/photos/:id` for signed-in users. Rate limits: vote POST 10/min/user, admin 60/min/user (configurable). `npm audit`: 0 vulnerabilities.

## Testing on a phone (same Wi-Fi)

```powershell
npm run dev:lan
```

Prints `Open on your phone: http://<your-LAN-IP>:5173`. It starts Vite on `0.0.0.0:5173` and the API as usual, and sets
`PUBLIC_BASE_URL` to that LAN URL **for this run only** (`.env` is not modified), so the Share dialog link and QR code point at the LAN address.
`npm run dev` still uses `localhost`. Override auto-detection with `$env:LAN_IP="192.168.1.20"; npm run dev:lan`.

- The phone must be on the same Wi-Fi as the PC (guest networks / "client isolation" block this).
- Windows Firewall: the Wi-Fi network is usually on the *Public* profile. Node needs an inbound allow rule. If the phone cannot connect, run once in an **admin** PowerShell:
  `New-NetFirewallRule -DisplayName "NamRA Voting dev (Vite 5173)" -Direction Inbound -Protocol TCP -LocalPort 5173 -Action Allow -Profile Private,Public`
  and remove it later with `Remove-NetFirewallRule -DisplayName "NamRA Voting dev (Vite 5173)"`.
- Cookies stay non-`Secure` in development (plain HTTP); they are `HttpOnly` + `SameSite=Strict`, which works on a LAN IP.
- If another Vite (e.g. another project) is bound to `127.0.0.1:5173`, `http://localhost:5173` on the PC may open that app; use the LAN URL instead.
