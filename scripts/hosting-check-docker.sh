#!/usr/bin/env bash
# Proves the Docker hosting setup end to end (CI job "hosting" and "release"; also usable on a clean machine with Docker):
#   image build (BASE_PATH=/voting-app) -> Postgres 16 (compose profile localdb) -> the role SQL from HOSTING.md -> migrations (twice)
#   -> app up and healthy -> /voting-app/api/health = 200 -> smoke flow (sign in, create campaign, vote) under /voting-app.
# usage: scripts/hosting-check-docker.sh [install dir]     (the folder holding docker-compose.yml; default: the repo root)
set -euo pipefail
REPO=$(cd "$(dirname "$0")/.." && pwd)
DIR=$(cd "${1:-$REPO}" && pwd)
cd "$DIR"

OWNER_PW=$(openssl rand -hex 16); APP_PW=$(openssl rand -hex 16); PG_PW=$(openssl rand -hex 16)
# A throw-away test install: AUTH_MODE=email-demo lets the smoke flow sign in without Microsoft. DEMO_USERS makes smoke.admin an admin.
cat > .env <<EOF
AUTH_MODE=email-demo
DEMO=true
DEMO_USERS='{"smoke.admin@namra.org.na":{"displayName":"Smoke Admin","roles":["CampaignAdmin"]}}'
PUBLIC_BASE_URL=http://127.0.0.1:8080
TRUST_PROXY=1
SESSION_SECRET=$(openssl rand -base64 48 | tr -d '=+/\n')
POSTGRES_PASSWORD=$PG_PW
MIGRATE_DATABASE_URL=postgres://namra_owner:$OWNER_PW@db:5432/namra
DATABASE_URL=postgres://namra_app:$APP_PW@db:5432/namra
APP_DB_PASSWORD=$APP_PW
DB_TLS=off
EOF

DC="docker compose --profile localdb"
cleanup() { status=$?; if [ "$status" -ne 0 ]; then echo "::group::container logs"; $DC logs --no-color --tail 150 || true; echo "::endgroup::"; fi; $DC down -v --remove-orphans >/dev/null 2>&1 || true; rm -f .env; exit "$status"; }
trap cleanup EXIT

mkdir -p data   # the member-list folder (HOSTING.md 6a): created by the installer, or Docker makes it root-owned
echo "== build the image"
$DC build
echo "== start PostgreSQL 16"
$DC up -d --wait db
ver=$($DC exec -T db psql -U postgres -tAc "show server_version_num" | tr -d '[:space:]')
echo "server_version_num=$ver"; [ "$ver" -ge 160000 ]
echo "== roles and database: the SQL from HOSTING.md section 1"
python3 "$REPO/scripts/hosting-sql.py" "$OWNER_PW" "$APP_PW" | $DC exec -T db psql -U postgres -v ON_ERROR_STOP=1
echo "== migrations (first run, then again: must be a no-op)"
$DC run --rm -T app node server/dist/migrateCli.js | tail -3
$DC run --rm -T app node server/dist/migrateCli.js | tee /dev/stderr | grep -q "migrations up to date"
echo "== member import (FAKE data): check, dry run, real run, second run"
printf 'Employee Code,Display Name,Email Address
ABC0001,Fake One,one@namra.org.na
ABC0002,Fake Two,two@namra.org.na
ABC0003,Fake Three,three@example.com
' > data/members.csv
out=$($DC run --rm -T app node server/dist/importMembers.js /data/members.csv --check-file || true); echo "$out"; echo "$out" | grep -q "3 rows read, 2 valid, 1 rejected"
out=$($DC run --rm -T app node server/dist/importMembers.js /data/members.csv --dry-run); echo "$out"; echo "$out" | grep -q "added:     2"
out=$($DC run --rm -T app node server/dist/importMembers.js /data/members.csv); echo "$out"; echo "$out" | grep -q "IMPORT DONE"
out=$($DC run --rm -T app node server/dist/importMembers.js /data/members.csv); echo "$out"; echo "$out" | grep -q "unchanged: 2"
if echo "$out" | grep -qE "ABC000|Fake|[a-z]@namra"; then echo "the import printed a code, name or address"; exit 1; fi
rm -f data/members.csv
echo "== start the app"
$DC up -d --wait app
echo "== health"
code=$(curl -s -o /tmp/health.json -w '%{http_code}' http://127.0.0.1:8080/voting-app/api/health); cat /tmp/health.json; echo " (HTTP $code)"
[ "$code" = 200 ]
echo "== smoke flow under /voting-app"
node "$REPO/scripts/hosting-smoke.mjs" http://127.0.0.1:8080/voting-app
echo "docker hosting check: OK"
