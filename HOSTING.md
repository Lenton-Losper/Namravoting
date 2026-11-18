# Hosting NamRA Staff Voting on a NamRA VM

> ## REQUIRED: the database must be PostgreSQL 16 or newer
>
> The app will not run on MySQL, MariaDB, SQL Server, Oracle or SQLite, and it has only been tested on PostgreSQL 16 (older versions are not supported).
> The vote-secrecy and integrity rules are enforced **inside the database**, using features that exist only in PostgreSQL:
>
> - PL/pgSQL triggers that stop the app's own login from altering or deleting votes, receipts, audit entries and announced results (`current_user = 'namra_app'` checks);
> - `SECURITY DEFINER` functions, column/table-level `GRANT`s and a second, restricted database role (`namra_app`);
> - `jsonb`, `text[]`, `INSERT ... ON CONFLICT`, `SELECT ... FOR UPDATE` and `SERIALIZABLE` transactions for exactly-once voting;
> - the `xmin` system column (the tally re-stamping that stops votes being linked to timestamps).
>
> A "compatible" database that lacks any of these would run the app without the protections that make the ballot secret.

URL once installed: **`https://<host>/voting-app/`** (the app lives under `/voting-app`; the reverse proxy forwards that path unchanged).

> ## Three things not to miss
>
> 1. **`TRUST_PROXY=1` is required behind nginx or IIS.** Without it every visitor looks like the proxy's address, they all share one rate limit (10 votes a minute), and people are locked out as soon as a few vote at once. Put `TRUST_PROXY=1` in the settings (use `2` if there are two proxies in a row).
> 2. **`namra_owner` needs `CREATEROLE`** (the SQL in section 1 gives it). The migration creates and re-sets the password of the `namra_app` role; without it the migration stops with "permission denied".
> 3. **Changing the path means a rebuild.** `/voting-app` is compiled into the web client's file addresses. To use another path you need a new build (and a new `BASE_PATH`, proxy rule and Entra redirect URI). The server refuses to start if the build and `BASE_PATH` disagree.

Two ways to run it. Pick one: **A. Docker (preferred)** or **B. plain Node 22 + systemd**. Both need the database (section 1), the settings (section 2) and a reverse proxy (section 5).

**The release package (`voting-app-release.zip`) is already built for `/voting-app`** (`client/dist` and `server/dist` are inside). Nobody has to build anything: Docker uses `Dockerfile.release`, which only installs the runtime packages, and the Node install is `npm ci --omit=dev` and start. `RELEASE.txt` in the package says which version it is. The build steps below are only for a plain source checkout.

| | |
|---|---|
| Database | PostgreSQL **16+**, one empty database, two roles (section 1) |
| App | one process on `127.0.0.1:8080`, needs outbound HTTPS to `login.microsoftonline.com` and `graph.microsoft.com` (sign-in) |
| Disk | a folder for candidate photos (Docker: the `uploads` volume; Node: `/var/lib/voting-app/uploads`). Back it up with the database |
| Proxy | nginx or IIS in front, HTTPS, forwarding `/voting-app` unchanged |

---

## Upgrading an existing install (the first zip is already running)

Read this section first if the previous `voting-app-release.zip` is already installed. Everything below is for **`https://apps.namra.org.na/voting-app`**, Microsoft Entra sign-in, PostgreSQL 16. Plan a few minutes of downtime and do it when no vote is open.

**What is new in this release:** database migrations 023 to 026 (voter-list protection, voting rules, member emails), the Umoja member import (`importMembers.js`), voting rules per position (pick range, region rule, a region for every candidate), the Umoja branding, and Microsoft-account binding of Umoja members by email. Photos, campaigns and votes are kept.

### Steps (Docker; for the plain Node install see the note after the list)

1. **Back up the database** (a restore point, before anything changes):
   ```bash
   pg_dump -h DB_HOST -U namra_owner -Fc namra > namra-before-upgrade-$(date +%F).dump
   ```
   and back up the photos volume (`docker run --rm -v <project>_uploads:/d -v "$PWD":/b alpine tar czf /b/uploads-$(date +%F).tgz -C /d .`).
2. **Stop the app:** `docker compose down` (the database is not touched).
3. **Replace the files.** Unzip the new release into the same folder, **overwriting** the old files. **Keep your `.env`** (the zip has none, so it is not overwritten) and keep the `uploads` volume.
4. **Update `.env`** (section 2 lists every setting). In short:
   - **Remove** the line `ENTRA_REDIRECT_URI=...` if there is one. The address is now built from `PUBLIC_BASE_URL` + `BASE_PATH`. (If you leave it, it must be exactly `https://apps.namra.org.na/voting-app/auth/callback`, otherwise the app refuses to start and says so.)
   - **Add** `ENTRA_SECRET_EXPIRES_AT=YYYY-MM-DD` (the client secret's expiry date from the Entra app registration). It is what makes the app warn the admins 30 days before sign-in would stop.
   - **Check** `AUTH_MODE=entra`, `PUBLIC_BASE_URL=https://apps.namra.org.na`, `TRUST_PROXY=1`, and the admin settings (below).
   - `BASE_PATH` is set by `docker-compose.yml` (`/voting-app`); do not put anything else.
5. **Create the data folder** for the member list (the new `docker-compose.yml` mounts it): `mkdir -p data`. The release zip already contains `data/umoja-emails.xlsx` (section 6a).
6. **Run the migrations:** `docker compose run --rm app node server/dist/migrateCli.js`. It prints `applied 023_...` to `applied 026_...` and then `migrations up to date`. Run it again: it must say `migrations up to date` and change nothing.
7. **Start:** `docker compose up -d`.
8. **Health check:** `docker compose ps` shows `(healthy)`; `curl -fsS http://127.0.0.1:8080/voting-app/api/health` answers `{"ok":true}`; `docker compose logs --tail 30 app` shows `[config] Microsoft redirect URI: https://apps.namra.org.na/voting-app/auth/callback`; then open `https://apps.namra.org.na/voting-app/` and sign in with Microsoft.
9. **Load the members:** section 6a (`--dry-run` first).

**If something goes wrong** after step 6: `docker compose down`, restore the dump (`pg_restore -c -d namra namra-before-upgrade-....dump`, or the Neon/PostgreSQL restore your team uses) and start the previous release again. Migrations 023 to 026 are not reversible by hand, so the dump from step 1 is the way back.

**Plain Node install (section 4):** the same order. Stop the service (`systemctl stop voting-app`), take the dump, unzip over the old folder keeping `.env`, `npm ci --omit=dev`, `node server/dist/migrateCli.js`, `systemctl start voting-app`, health check.

---

## 1. Create the database (PostgreSQL 16+)

The app uses two roles. The **owner** (`namra_owner`) runs the migrations and is never used by the running app. **`namra_app`** is what the running app logs in as; it can only do what the ballot rules allow.

Run this once on the new server as a superuser (for example `sudo -u postgres psql`), replacing the two passwords with long random ones (no `$` or `'` characters keep it simple):

```sql
CREATE ROLE namra_owner LOGIN PASSWORD 'REPLACE_WITH_OWNER_PASSWORD' CREATEROLE;
CREATE ROLE namra_app   LOGIN PASSWORD 'REPLACE_WITH_APP_PASSWORD';
GRANT namra_app TO namra_owner WITH ADMIN OPTION;   -- lets the owner's migrations manage namra_app (PostgreSQL 16 rule)
CREATE DATABASE namra OWNER namra_owner ENCODING 'UTF8';
REVOKE ALL ON DATABASE namra FROM PUBLIC;
GRANT CONNECT ON DATABASE namra TO namra_app;
```

Check: `psql "postgres://namra_owner:...@DB_HOST:5432/namra" -c "select version()"` shows PostgreSQL 16 or newer.

Notes
- The first migration run creates all tables, triggers and the grants for `namra_app`. Nothing else needs to be created by hand.
- `CREATEROLE` on the owner is needed because the migration (re)sets the `namra_app` password from `APP_DB_PASSWORD`. If your policy forbids `CREATEROLE`, ask the developers.
- **TLS:** if the database is on another machine, the app connects with TLS and verifies the certificate (it refuses to weaken this from the URL). If the server uses a private certificate authority, set `DB_SSL_CA=/path/to/ca.pem`. If the database is on the same VM or a trusted private network without TLS, set `DB_TLS=off` (an explicit setting; leave it unset for any other case).
- Where a database runs in the same Docker setup, see 3.4.

## 2. Settings (the `.env` file)

Settings are environment variables. Make a file from `.env.example` (**the file is `.env`, it holds secrets, never put it in the zip, git or an email**). Use the *production* section at the bottom of `.env.example`; delete the development lines above it.

```
AUTH_MODE=entra
PUBLIC_BASE_URL=https://apps.namra.org.na      # origin only, no path
TRUST_PROXY=1                                    # one reverse proxy in front (nginx / IIS)
SESSION_SECRET=<48+ random characters>
MIGRATE_DATABASE_URL=postgres://namra_owner:OWNER_PASSWORD@DB_HOST:5432/namra
DATABASE_URL=postgres://namra_app:APP_PASSWORD@DB_HOST:5432/namra
APP_DB_PASSWORD=APP_PASSWORD                     # same as in DATABASE_URL
ENTRA_TENANT_ID=fe7b029e-7e19-4525-bdf4-57462a59d299
ENTRA_CLIENT_ID=281ab38e-9ff5-4f17-88ea-18bdc3e65457
ENTRA_CLIENT_SECRET=<the secret VALUE, sent to you separately: never in the zip, git or an email>
ENTRA_SECRET_EXPIRES_AT=YYYY-MM-DD               # the client secret's expiry date: admins are warned 30 days before
ADMIN_EMAILS=lenton.losper@namra.org.na          # who can create campaigns, until ADMIN_OIDS replaces it (see "Admins")
ADMIN_EMAILS_FALLBACK=true
```

`BASE_PATH=/voting-app` is set for you by Docker (`docker-compose.yml`); for the plain Node install put it in the env file too.

### What each new or changed setting does

| Setting | Value | Notes |
|---|---|---|
| `AUTH_MODE` | `entra` | Microsoft sign-in. The only mode for the VM. |
| `PUBLIC_BASE_URL` | `https://apps.namra.org.na` | The origin only; the app adds `BASE_PATH` itself. |
| `BASE_PATH` | `/voting-app` | Set by `docker-compose.yml`. |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID` | as above | Not secret. |
| `ENTRA_CLIENT_SECRET` | the secret **Value** | Sent to the DBA separately. If sign-in shows `AADSTS7000215` the Secret ID was copied instead of the Value; `AADSTS7000222` means the secret has expired. |
| `ENTRA_SECRET_EXPIRES_AT` | `YYYY-MM-DD` | New. Admins see a warning 30 days before; the log warns daily. |
| `TRUST_PROXY` | `1` | Required behind nginx or IIS (`2` for two proxies). |
| `ENTRA_REDIRECT_URI` | **do not set** | Built from `PUBLIC_BASE_URL` + `BASE_PATH`. If you still have it from the first install, delete it (or it must equal the address below). |

### Admins

Nobody has the administrator's Entra object id yet, so start with the email address:

```
ADMIN_EMAILS=lenton.losper@namra.org.na
ADMIN_EMAILS_FALLBACK=true
```

With these, the account that signs in with that exact (lower-cased) address is a campaign administrator. The app logs a start-up warning that admins are matched by email; that is expected for now.

**Switching to object ids later (recommended once the first sign-in has happened).** An email address can be renamed or reused; an object id cannot:

1. Sign in once with Microsoft, then open `https://apps.namra.org.na/voting-app/api/session` in the same browser. The answer starts `{"user":{"oid":"xxxxxxxx-xxxx-...","email":...`: **`oid` is the Entra object id**. (Alternatives: Entra admin centre -> Users -> the person -> *Object ID*, or `SELECT entra_oid FROM users WHERE email = 'lenton.losper@namra.org.na';` as the owner role.)
2. In `.env` set `ADMIN_OIDS=<that oid>` (comma-separated for several people) and **remove** `ADMIN_EMAILS` and `ADMIN_EMAILS_FALLBACK`.
3. Restart (`docker compose up -d --force-recreate app`). Sign in again: the admin banner about email matching is gone.

### No demo data, and the demo sign-in cannot be switched on by accident

- **No fake or demo data is ever loaded in production.** The migrations create tables only (no members, users, campaigns or candidates). The seed and demo scripts (`npm run seed`, `demo-setup`) are developer tools: `seed` refuses to run when `NODE_ENV=production` (which the production settings set), and nothing starts them. The fake `TST...` Umoja members, the demo users and the demo campaigns exist only in the developers' and the Cloudflare test databases, never in your database. After loading the member list (section 6a) the database holds exactly the people in HR's file.
- **`AUTH_MODE=email-demo`** (sign in by typing an address, no proof of identity) and `dev` are in the code but are locked: `dev` is refused whenever `NODE_ENV=production`; `email-demo` is refused in production unless **`DEMO=true`** is also set, and the example settings contain neither. Never add `DEMO`, `DEMO_USERS` or `DEMO_MEMBER_EMAILS` to the VM's `.env` (the app refuses `DEMO_MEMBER_EMAILS` without `DEMO=true` as well). A login page that shows a box to type an email address means the settings are wrong: stop and check `AUTH_MODE`.

Generate `SESSION_SECRET`: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` (or `openssl rand -base64 48`).

- `BASE_PATH` is `/voting-app`. Docker sets it for you (in `docker-compose.yml`). For the plain Node install, put `BASE_PATH=/voting-app` in the env file **and** build with it (section 4).
- **Microsoft sign-in, the redirect URI IT must register.** There is no `ENTRA_REDIRECT_URI` setting to fill in: the app builds the address Microsoft sends people back to as `PUBLIC_BASE_URL` + `BASE_PATH` + `/auth/callback`. With the values in this guide that is exactly:

  ```
  https://apps.namra.org.na/voting-app/auth/callback
  ```

  In the Entra admin centre: App registrations -> **NamRA Voting** (application/client id `281ab38e-9ff5-4f17-88ea-18bdc3e65457`) -> Authentication -> Add a platform / Add URI -> **Web** -> paste that address, character for character (https, no trailing slash, `/voting-app/` included). It is added next to the existing redirect URI, so the live site keeps working until the move. If `PUBLIC_BASE_URL` is a different host, register that host's address instead: `<PUBLIC_BASE_URL>/voting-app/auth/callback`. The app prints the address it uses in its start-up log line `[config] Microsoft redirect URI: ...`. (An old `ENTRA_REDIRECT_URI` line, if you have one, is only accepted when it is identical to this address; remove it.)
- `AUTH_MODE=email-demo` and `dev` sign people in without proof of identity and are locked in production (see "No demo data" above). Never use them for a real election.
- With Docker Compose, avoid the `$` character in values (Compose treats it as a variable).
- Everything else has safe defaults. The full list is in `.env.example` and `docs/operations.md`.

## 3. Option A: Docker (preferred)

Needs Docker Engine with the Compose plugin (v2.20 or newer). Run the commands in the folder you unzipped, next to `docker-compose.yml` and `.env`.

### 3.1 Build and prepare

```bash
cp .env.example .env            # then edit .env as in section 2 (delete the development lines above the production section)
mkdir -p data                  # folder for the Umoja member list (section 6a); create it now, or Docker creates it owned by root
docker compose build            # release package: installs the runtime packages only. Source checkout: also compiles the app (BASE_PATH=/voting-app)
```

### 3.2 Create the tables (migrations), then start

```bash
docker compose run --rm app node server/dist/migrateCli.js     # prints "applied 001_schema.sql ..." then "migrations up to date"
docker compose up -d
```

Run the migration command again after every upgrade (it only applies what is new).

### 3.3 Check it is healthy

```bash
docker compose ps                                              # app: "Up ... (healthy)"
curl -fsS http://127.0.0.1:8080/voting-app/api/health          # {"ok":true}  (200 only if the database answers)
docker compose logs --tail 50 app                              # "NamRA voting API listening on 0.0.0.0:8080 ..."
```

Then, through the reverse proxy: `curl -i https://apps.namra.org.na/voting-app/api/health` and open `https://apps.namra.org.na/voting-app/` in a browser.

If the container exits at once, `docker compose logs app` shows one line starting `STARTUP ERROR` or `Refusing to start` that names the setting at fault (never its value).

### 3.4 Optional: PostgreSQL 16 in Docker on the same VM

Only if the hosting team prefers not to run the database separately. It is a normal `postgres:16` container with its own volume (`pgdata`) and no published port; only the app container reaches it (host name `db`). Its administrator is the usual `postgres` superuser, and you create the roles and the database with **the same SQL as section 1**. In `.env`:

```
POSTGRES_PASSWORD=<password of the postgres superuser inside the container>
MIGRATE_DATABASE_URL=postgres://namra_owner:<owner password>@db:5432/namra
DATABASE_URL=postgres://namra_app:<app password>@db:5432/namra
APP_DB_PASSWORD=<app password>
DB_TLS=off                      # the container has no TLS; it is reachable only by the app container
```

Then add `--profile localdb` to every command:

```bash
docker compose --profile localdb build
docker compose --profile localdb up -d db
docker compose --profile localdb exec db psql -U postgres     # paste the SQL from section 1 (with your two passwords), then \q
docker compose --profile localdb run --rm app node server/dist/migrateCli.js
docker compose --profile localdb up -d
```

Back it up: `docker compose --profile localdb exec db pg_dump -U namra_owner -Fc namra > namra-$(date +%F).dump`, plus the `uploads` volume. See `docs/disaster-recovery.md` for restore drills.

### 3.5 Upgrade

See **Upgrading an existing install** at the top of this guide (back up, stop, unzip over the old folder keeping `.env`, migrate, start, health check). The photos (`uploads`) and database are kept.

## 4. Option B: plain Node 22 on the VM

Needs Node.js **22 LTS** and `npm` (and, to install packages, access to the npm registry or an internal mirror). Linux with systemd is assumed.

```bash
# 1. A service account and folders
sudo useradd --system --create-home --home-dir /opt/voting-app --shell /usr/sbin/nologin votingapp
sudo mkdir -p /etc/voting-app /var/lib/voting-app/uploads
sudo chown votingapp:votingapp /var/lib/voting-app/uploads

# 2. Unpack the release into /opt/voting-app/app
sudo mkdir -p /opt/voting-app/app && sudo unzip voting-app-release.zip -d /opt/voting-app/app
sudo chown -R votingapp:votingapp /opt/voting-app

# 3. Install the runtime packages. The release package is already built for /voting-app.
cd /opt/voting-app/app
sudo -u votingapp npm ci --omit=dev
#    Only for a source checkout (no client/dist folder): npm ci, then  env BASE_PATH=/voting-app npm run build

# 4. Settings: the file from section 2 plus these four lines, readable only by root and the service
sudo cp .env.example /etc/voting-app/voting-app.env      # then edit it (delete the development lines)
cat <<'EOF' | sudo tee -a /etc/voting-app/voting-app.env
NODE_ENV=production
PORT=8080
BASE_PATH=/voting-app
UPLOAD_DIR=/var/lib/voting-app/uploads
EOF
sudo chown root:votingapp /etc/voting-app/voting-app.env && sudo chmod 640 /etc/voting-app/voting-app.env

# 5. Create the tables
sudo -u votingapp bash -c 'set -a; . /etc/voting-app/voting-app.env; set +a; node server/dist/migrateCli.js'
```

In the env file keep values on one line, `NAME=value`, with no quotes (systemd reads it as is). Lines that begin with `#` are ignored.

### systemd service: `/etc/systemd/system/voting-app.service`

```ini
[Unit]
Description=NamRA Staff Voting
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=votingapp
Group=votingapp
WorkingDirectory=/opt/voting-app/app
EnvironmentFile=/etc/voting-app/voting-app.env
ExecStart=/usr/bin/node server/dist/index.js
Restart=on-failure
RestartSec=5
# Hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/var/lib/voting-app

[Install]
WantedBy=multi-user.target
```

(`which node` should print `/usr/bin/node`; if not, put the real path in `ExecStart`.)

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now voting-app
systemctl status voting-app                                       # active (running)
curl -fsS http://127.0.0.1:8080/voting-app/api/health             # {"ok":true}
journalctl -u voting-app -n 50 --no-pager                         # "NamRA voting API listening on 0.0.0.0:8080 ..."
```

`Restart=on-failure` keeps it running after a crash, and `enable` starts it at boot.

Upgrade: unzip the new release over `/opt/voting-app/app` (the env file lives in `/etc`, so it is kept), `sudo -u votingapp npm ci --omit=dev`, run the migration command from step 5, `sudo systemctl restart voting-app`.

Without systemd (for a quick test): `cd /opt/voting-app/app && set -a && . /etc/voting-app/voting-app.env && set +a && node server/dist/index.js`.

## 5. Reverse proxy: forward `/voting-app` unchanged

The proxy must pass the path **as is** (`/voting-app/...` arrives at the app as `/voting-app/...`; do not strip the prefix). The app only listens on `127.0.0.1:8080`; terminate HTTPS at the proxy.

### nginx

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name apps.namra.org.na;
    ssl_certificate     /etc/ssl/certs/apps.namra.org.na.pem;
    ssl_certificate_key /etc/ssl/private/apps.namra.org.na.key;

    client_max_body_size 4m;                       # candidate photos (the app allows 2 MB)

    location = /voting-app { return 301 /voting-app/; }

    location /voting-app/ {
        proxy_pass http://127.0.0.1:8080;          # NO path after the port: the request path is forwarded unchanged
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header CF-Connecting-IP  $remote_addr;   # the visitor's address, for per-visitor rate limits (overwrites any forged value)
        proxy_read_timeout 60s;                    # PDF / Excel exports
    }
}
server { listen 80; server_name apps.namra.org.na; return 301 https://$host$request_uri; }
```

Test and reload: `sudo nginx -t && sudo systemctl reload nginx`. Keep `TRUST_PROXY=1` in the settings (one proxy hop). If another proxy sits in front of nginx, use `2`.

### IIS (Windows Server) as the reverse proxy

1. Install **URL Rewrite** and **Application Request Routing (ARR)**. In IIS Manager, select the server, Application Request Routing Cache, Server Proxy Settings, tick **Enable proxy**. Leave "Reverse rewrite host in response headers" ticked.
2. On the site (HTTPS binding with the certificate), add this rule to its `web.config`. It forwards `/voting-app` and everything under it to the app **with the path unchanged**:

```xml
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="voting-app" stopProcessing="true">
          <match url="^voting-app(/.*)?$" />
          <action type="Rewrite" url="http://127.0.0.1:8080/voting-app{R:1}" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
```

   The query string is passed on automatically. Do not use "Redirect", and do not remove `/voting-app` from the target URL.
3. If the app runs on another machine, replace `127.0.0.1` with its address and let that machine's firewall accept port 8080 from the IIS server only (set the app's `PORT`/bind and, in Docker, the `ports:` line in `docker-compose.yml` accordingly).
4. ARR adds an `X-Forwarded-For` header; keep `TRUST_PROXY=1` so each visitor gets their own rate limit. If every visitor appears to share one limit (people get "Too many requests" while only a few are voting), the proxy is not sending that header.

## 6. After it is running

- Sign in at `https://apps.namra.org.na/voting-app/` with the administrator account (section 2, "Admins"), create a test campaign, open its share link on a phone.
- Changing the path later (for example from `/voting-app` to `/vote`) means **a rebuild**: a new package built with the new path (or, from source: change both places in `docker-compose.yml` and `docker compose build`, or `env BASE_PATH=/vote npm run build`), plus `BASE_PATH`, the proxy rule and the Entra redirect URI. The server refuses to start if the built client and `BASE_PATH` disagree.
- Backups, restores and retention: `docs/disaster-recovery.md`, `docs/retention.md`. Day-to-day settings: `docs/operations.md`.

## 6a. Load Umoja members

Umoja votes are open to the members on the list NamRA HR gives you. Load it once after the first start, and again whenever HR sends an updated list. The command reads the file and writes to the database with the **owner** connection (`MIGRATE_DATABASE_URL` in `.env`, the same one the migrations use).

**The file** is an Excel (`.xlsx`) or `.csv` file with a header row and these columns, in any order (other columns are ignored):

| Employee Code | Display Name | Email Address |
|---|---|---|
| ABC0001 | (a name) | first.last@namra.org.na |

- Employee codes are three letters and four digits (case does not matter). Email addresses are trimmed and lower-cased and must end in `@namra.org.na`.
- A row with an invalid code, an invalid address or an address outside `@namra.org.na` is **rejected** (not loaded) and reported by its **row number**, the number your spreadsheet shows. Nothing else is stopped.
- The **display name is only read to recognise the file; it is never stored**, printed or logged.
- **The file is sensitive personal data. Never put it in git, an email or the release zip.** Keep it in the `data/` folder next to `docker-compose.yml` (the repository ignores `data/*.xlsx` and `data/*.csv`) and delete it when you are done.

**What the command does.** For each Employee Code: a new one is **added** (as an active member), one that exists with a different address is **updated** (the address only), one that exists with the same address is **unchanged**. It **never deletes** a member, never changes an existing member's active flag or Microsoft match, and an address that already belongs to another member rejects that row. It is safe to run twice. It prints counts (added, updated, unchanged, rejected) and row numbers, **never names, addresses or codes**, and writes one audit-log entry with the counts and the **SHA-256 of the file**.

**This release ships the HR list as `data/umoja-emails.xlsx`** (1,066 members; columns Employee Code, Display Name, Email Address). It is the only data file in the zip. **It is personal data: after the real run succeeds, delete it from the VM** (`rm data/umoja-emails.xlsx`), keep no copy in email or chat, and never put it in git.

**Expected result on the new, empty database** (no members yet; this is what a correct file gives):

| Run | added | updated | unchanged | rejected |
|---|---|---|---|---|
| `--dry-run` (changes nothing) | **1066** | 0 | 0 | 0 |
| real run | **1066** | 0 | 0 | 0 |
| a second real run (safe, nothing changes) | 0 | 0 | **1066** | 0 |

The file's SHA-256 is printed on the first line (`File: SHA-256 ...`) and recorded in the audit log. If the counts differ (for example `rejected` above 0, or `added` far from 1066), **stop and tell the developers before the real run**.

**Docker** (the file is `data/umoja-emails.xlsx` next to `docker-compose.yml`, which the app container sees as `/data/umoja-emails.xlsx`; create the folder yourself with `mkdir -p data` **before the first `docker compose` command**, or Docker creates it owned by root):

```bash
# 1. Check the file itself (no database is touched): row counts and rejected row numbers
docker compose run --rm app node server/dist/importMembers.js /data/umoja-emails.xlsx --check-file

# 2. Dry run: the same work against the database, then undone. Prints the counts a real run would give; changes nothing
docker compose run --rm app node server/dist/importMembers.js /data/umoja-emails.xlsx --dry-run

# 3. The real run
docker compose run --rm app node server/dist/importMembers.js /data/umoja-emails.xlsx
```

**Plain Node** (section 4), from the folder that holds `server/` and `.env`:

```bash
node server/dist/importMembers.js /path/to/umoja-emails.xlsx --dry-run
node server/dist/importMembers.js /path/to/umoja-emails.xlsx
# or: npm run members:import -- /path/to/umoja-emails.xlsx --dry-run
```

**When HR sends an updated list:** replace the file (same name or a new one), then repeat steps 1 to 3. People already loaded show as *unchanged*, new people as *added*, changed addresses as *updated*. **Members who are no longer on the new list are NOT removed**: tell the developers if someone must stop being a member.

Exit codes: `0` done, `1` it could not run (nothing changed; the message says why), `2` (only with `--check-file`) the file was read but some rows are rejected. A public cloud database (for example the Cloudflare demo's) is refused unless you add `--allow-remote`: the real member list belongs only on the NamRA VM.

## 7. If something is wrong

| Symptom | Likely cause |
|---|---|
| Container/service stops at once, log says `Refusing to start: ...` | the named setting is missing or invalid (the message never prints values) |
| `Refusing to start: BASE_PATH is "/voting-app" but client/dist was built for ""` | the client was built without `BASE_PATH`. Rebuild (Docker: `docker compose build`; Node: `env BASE_PATH=/voting-app npm run build`) |
| `/voting-app/api/health` returns `{"ok":false}` (503) | the database is unreachable or `DATABASE_URL` is wrong. Check the host, password, and TLS (`DB_SSL_CA` / `DB_TLS`) |
| Browser shows a blank page, files `404` | the proxy is stripping `/voting-app`, or the client was built for a different path |
| After Microsoft sign-in: error page / loop | the redirect URI registered in Entra is not exactly `PUBLIC_BASE_URL` + `/voting-app/auth/callback` (see section 2), or `PUBLIC_BASE_URL` is wrong |
| "Too many requests" for everyone | the proxy does not send `X-Forwarded-For` or `TRUST_PROXY` is unset |
| `migration NNN failed: permission denied to ...` | the owner role lacks `CREATEROLE`, or `MIGRATE_DATABASE_URL` points at `namra_app` instead of the owner |
