#!/usr/bin/env bash
#
# scripts/web-social-e2e.sh — the social MVP in the BROWSER, against a REAL server.
#
# Boots the real relay on a scratch database at localhost:3199 (the address the real-relay suite and its seed scripts
# use), seeds the community, the people, their follows and posts, and a few launches (`web/tests/e2e-real/seed.mjs`,
# `seed-social.mjs` and `seed-demo.mjs`),
# then runs `web/tests/e2e-real/social.spec.ts` (posting, following, votes, replies, reposts, quotes, bookmarks, search,
# notifications, profiles, muting, direct messages, deleting) and `board-moderation.spec.ts` (a board's moderation and
# reports, the author told of a removal, a mute on boards). Nothing is mocked: real signed requests, real database rows,
# real WebSocket sign-in. This is the local, automated version of the roadmap's three-account social run; it does not
# replace running it on the hosted server with real people.
#
# ⚠️  DEV ONLY. Needs Postgres and Redis running (see `just services`). Uses its own database, dropped on exit.
#
# Usage:  scripts/web-social-e2e.sh [playwright args]
# Env:    SKIP_BUILD=1 (reuse the web build and target/debug/buzz-relay), POSTGRES_ADMIN_URL,
#         WEB_DIST (the web build to serve; default web/dist, built here unless SKIP_BUILD=1),
#         SPECS (which real-relay specs to run; default both above)

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
step() { printf '\033[36m[web-social]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[web-social] %s\033[0m\n' "$*" >&2; exit 1; }

ADMIN_URL="${POSTGRES_ADMIN_URL:-postgres://buzz:buzz_dev@localhost:5432/postgres}"
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1]);s.close()'; }
PORT=3199
HEALTH=$(free_port); METRICS=$(free_port)
DB="buzz_social_e2e_$$"
DB_URL="${ADMIN_URL%/*}/$DB"
WEB_DIST="${WEB_DIST:-$REPO_ROOT/web/dist}"
STATE="$(mktemp -d)"
RELAY_PID=""
cleanup() {
  [[ -n "$RELAY_PID" ]] && kill "$RELAY_PID" 2>/dev/null || true
  psql "$ADMIN_URL" -qc "drop database if exists $DB with (force)" >/dev/null 2>&1 || true
  rm -f "$REPO_ROOT/web/tests/e2e-real/.social-fixture.json"
  rm -rf "$STATE"
}
trap cleanup EXIT

if lsof -ti "tcp:$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "port $PORT is already in use (the real-relay suite needs it): $(lsof -ti "tcp:$PORT" -sTCP:LISTEN | head -1)"
fi

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app and the relay"
  pnpm -C web exec vite build --outDir "$WEB_DIST" --emptyOutDir >/dev/null 2>&1 || fail "web build failed"
  cargo build -q -p buzz-relay || fail "relay build failed"
fi
[[ -x target/debug/buzz-relay ]] || fail "no target/debug/buzz-relay (build it, or unset SKIP_BUILD)"
[[ -f "$WEB_DIST/index.html" ]] || fail "no web build in $WEB_DIST (build it, or unset SKIP_BUILD)"
# A copy of the relay, so another build replacing target/debug/buzz-relay mid-run cannot change what is running.
cp target/debug/buzz-relay "$STATE/buzz-relay"

step "a scratch database ($DB)"
psql "$ADMIN_URL" -qc "create database $DB" || fail "could not create the scratch database (is Postgres running?)"

step "starting the relay on :$PORT"
if [[ -f .env ]]; then set -a; source .env; set +a; fi
DATABASE_URL="$DB_URL" BUZZ_AUTO_MIGRATE=true BUZZ_RELAY_PRIVATE_KEY="$(openssl rand -hex 32)" \
  BUZZ_BIND_ADDR="0.0.0.0:$PORT" BUZZ_RELAY_URL="ws://localhost:$PORT" RELAY_URL="ws://localhost:$PORT" \
  BUZZ_HEALTH_PORT="$HEALTH" BUZZ_METRICS_PORT="$METRICS" \
  BUZZ_WEB_DIR="$WEB_DIST" BUZZ_WEB_SPA=full \
  BUZZ_REQUIRE_RELAY_MEMBERSHIP=false \
  BUZZ_RATE_LIMIT_HUMAN_MESSAGES_PER_MIN=600 BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC=2000 \
  BUZZ_NEW_ACCOUNT_POSTS_PER_HOUR=0 \
  "$STATE/buzz-relay" >"$STATE/relay.log" 2>&1 &
RELAY_PID=$!
for _ in $(seq 1 120); do
  curl -fsS -m 2 -H 'Accept: application/nostr+json' "http://localhost:$PORT/" >/dev/null 2>&1 && break
  kill -0 "$RELAY_PID" 2>/dev/null || { tail -30 "$STATE/relay.log"; fail "the relay exited"; }
  sleep 1
done
curl -fsS -m 2 -H 'Accept: application/nostr+json' "http://localhost:$PORT/" >/dev/null \
  || { tail -30 "$STATE/relay.log"; fail "the relay did not come up"; }

cd web
step "seeding the community, its channel and the people"
node --experimental-strip-types tests/e2e-real/seed.mjs "$DB_URL" "ws://localhost:$PORT" >"$STATE/seed.log" 2>&1 \
  || { cat "$STATE/seed.log"; fail "seed.mjs failed"; }
node --experimental-strip-types tests/e2e-real/seed-social.mjs "$DB_URL" "ws://localhost:$PORT" >"$STATE/seed-social.log" 2>&1 \
  || { cat "$STATE/seed-social.log"; fail "seed-social.mjs failed"; }
# Launch records and pitches: the launch-update tests post about them.
node --experimental-strip-types tests/e2e-real/seed-demo.mjs "ws://localhost:$PORT" >"$STATE/seed-demo.log" 2>&1 \
  || { cat "$STATE/seed-demo.log"; fail "seed-demo.mjs failed"; }

step "running the browser specs"
set +e
BUZZ_REAL_RELAY_URL="http://localhost:$PORT" DATABASE_URL="$DB_URL" \
  node_modules/.bin/playwright test --config=playwright.real-relay.config.ts \
  ${SPECS:-tests/e2e-real/social.spec.ts tests/e2e-real/board-moderation.spec.ts} --reporter=list "$@"
status=$?
set -e
if [[ $status -ne 0 ]]; then
  step "relay log (last 40 lines)"
  tail -40 "$STATE/relay.log"
fi
exit $status
