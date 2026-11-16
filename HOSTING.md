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
PUBLIC_BASE_URL=https://voting.namra.org.na      # origin only, no path
TRUST_PROXY=1                                    # one reverse proxy in front (nginx / IIS)
SESSION_SECRET=<48+ random characters>
MIGRATE_DATABASE_URL=postgres://namra_owner:OWNER_PASSWORD@DB_HOST:5432/namra
DATABASE_URL=postgres://namra_app:APP_PASSWORD@DB_HOST:5432/namra
APP_DB_PASSWORD=APP_PASSWORD                     # same as in DATABASE_URL
ENTRA_TENANT_ID=...
ENTRA_CLIENT_ID=...
ENTRA_CLIENT_SECRET=...
ENTRA_REDIRECT_URI=https://voting.namra.org.na/voting-app/auth/callback
ENTRA_SECRET_EXPIRES_AT=2027-05-30
ADMIN_OIDS=<object id>,<object id>               # who can create campaigns
```

Generate `SESSION_SECRET`: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` (or `openssl rand -base64 48`).

- `BASE_PATH` is `/voting-app`. Docker sets it for you (in `docker-compose.yml`). For the plain Node install, put `BASE_PATH=/voting-app` in the env file **and** build with it (section 4).
- **Microsoft sign-in:** in the Entra admin centre, App registration, Authentication, add a **Web** redirect URI exactly equal to `ENTRA_REDIRECT_URI` (it must contain `/voting-app/`). The app refuses to start if `ENTRA_REDIRECT_URI` does not end with `/voting-app/auth/callback`.
- `AUTH_MODE=email-demo` and `dev` sign people in without proof of identity. Never use them for a real election. In production the app refuses `dev`.
- With Docker Compose, avoid the `$` character in values (Compose treats it as a variable).
- Everything else has safe defaults. The full list is in `.env.example` and `docs/operations.md`.

## 3. Option A: Docker (preferred)

Needs Docker Engine with the Compose plugin (v2.20 or newer). Run the commands in the folder you unzipped, next to `docker-compose.yml` and `.env`.

### 3.1 Build and prepare

```bash
cp .env.example .env            # then edit .env as in section 2 (delete the development lines above the production section)
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

Then, through the reverse proxy: `curl -i https://voting.namra.org.na/voting-app/api/health` and open `https://voting.namra.org.na/voting-app/` in a browser.

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

Unzip the new release over the old folder (keep `.env`), then `docker compose build`, run the migration command (3.2), `docker compose up -d`. The photos (`uploads`) and database are kept.

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
    server_name voting.namra.org.na;
    ssl_certificate     /etc/ssl/certs/voting.namra.org.na.pem;
    ssl_certificate_key /etc/ssl/private/voting.namra.org.na.key;

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
server { listen 80; server_name voting.namra.org.na; return 301 https://$host$request_uri; }
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

- Sign in at `https://voting.namra.org.na/voting-app/` with a NamRA account listed in `ADMIN_OIDS`, create a test campaign, open its share link on a phone.
- Changing the path later (for example from `/voting-app` to `/vote`) means **a rebuild**: a new package built with the new path (or, from source: change both places in `docker-compose.yml` and `docker compose build`, or `env BASE_PATH=/vote npm run build`), plus `BASE_PATH`, the proxy rule and the Entra redirect URI. The server refuses to start if the built client and `BASE_PATH` disagree.
- Backups, restores and retention: `docs/disaster-recovery.md`, `docs/retention.md`. Day-to-day settings: `docs/operations.md`.

## 7. If something is wrong

| Symptom | Likely cause |
|---|---|
| Container/service stops at once, log says `Refusing to start: ...` | the named setting is missing or invalid (the message never prints values) |
| `Refusing to start: BASE_PATH is "/voting-app" but client/dist was built for ""` | the client was built without `BASE_PATH`. Rebuild (Docker: `docker compose build`; Node: `env BASE_PATH=/voting-app npm run build`) |
| `/voting-app/api/health` returns `{"ok":false}` (503) | the database is unreachable or `DATABASE_URL` is wrong. Check the host, password, and TLS (`DB_SSL_CA` / `DB_TLS`) |
| Browser shows a blank page, files `404` | the proxy is stripping `/voting-app`, or the client was built for a different path |
| After Microsoft sign-in: error page / loop | `ENTRA_REDIRECT_URI` differs from the one registered in Entra, or does not contain `/voting-app/` |
| "Too many requests" for everyone | the proxy does not send `X-Forwarded-For` or `TRUST_PROXY` is unset |
| `migration NNN failed: permission denied to ...` | the owner role lacks `CREATEROLE`, or `MIGRATE_DATABASE_URL` points at `namra_app` instead of the owner |
