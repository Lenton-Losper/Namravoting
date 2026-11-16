#!/usr/bin/env bash
# Proves the plain-Node hosting setup from a release package (CI job "release"):
#   npm ci --omit=dev -> role SQL from HOSTING.md -> migrations -> node server/dist/index.js -> health -> smoke flow, all under /voting-app.
# usage: scripts/hosting-check-node.sh <unzipped release dir>
# needs a PostgreSQL 16 superuser reachable with PGHOST/PGPORT/PGUSER/PGPASSWORD (CI: a service container).
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
DIR=$(cd "$1" && pwd)
: "${PGHOST:?}" "${PGPORT:?}" "${PGUSER:?}" "${PGPASSWORD:?}"

OWNER_PW=$(openssl rand -hex 16); APP_PW=$(openssl rand -hex 16)
echo "== roles and database: the SQL from HOSTING.md section 1"
python3 "$REPO/scripts/hosting-sql.py" "$OWNER_PW" "$APP_PW" | psql -v ON_ERROR_STOP=1 -d postgres
[ "$(psql -d postgres -tAc 'show server_version_num')" -ge 160000 ]

cd "$DIR"
test -f client/dist/index.html && test -f server/dist/index.js         # prebuilt: nothing to compile
echo "== npm ci --omit=dev"
npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -2
if [ -d node_modules/typescript ] || [ -d node_modules/vite ]; then echo "dev dependencies were installed"; exit 1; fi

# the env file a systemd unit would read (HOSTING.md section 4)
ENVFILE=$(mktemp)
cat > "$ENVFILE" <<EOF
NODE_ENV=production
PORT=18080
BASE_PATH=/voting-app
UPLOAD_DIR=$(mktemp -d)
AUTH_MODE=email-demo
DEMO=true
DEMO_USERS='{"smoke.admin@namra.org.na":{"displayName":"Smoke Admin","roles":["CampaignAdmin"]}}'
PUBLIC_BASE_URL=http://127.0.0.1:18080
TRUST_PROXY=1
SESSION_SECRET=$(openssl rand -base64 48 | tr -d '=+/\n')
MIGRATE_DATABASE_URL=postgres://namra_owner:$OWNER_PW@$PGHOST:$PGPORT/namra
DATABASE_URL=postgres://namra_app:$APP_PW@$PGHOST:$PGPORT/namra
APP_DB_PASSWORD=$APP_PW
EOF
set -a; . "$ENVFILE"; set +a
echo "== migrations"
node server/dist/migrateCli.js | tail -2
echo "== start: node server/dist/index.js"
node server/dist/index.js > app.log 2>&1 &
PID=$!
trap 'status=$?; kill $PID 2>/dev/null || true; if [ "$status" -ne 0 ]; then echo "::group::app.log"; cat app.log; echo "::endgroup::"; fi; rm -f "$ENVFILE"; exit "$status"' EXIT
for i in $(seq 1 30); do curl -fsS http://127.0.0.1:18080/voting-app/api/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsS http://127.0.0.1:18080/voting-app/api/health; echo
echo "== smoke flow under /voting-app"
node "$REPO/scripts/hosting-smoke.mjs" http://127.0.0.1:18080/voting-app
echo "node hosting check: OK"
