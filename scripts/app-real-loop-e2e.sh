#!/usr/bin/env bash
#
# scripts/app-real-loop-e2e.sh — the new app (app/, plan v2 milestone 6) against a REAL server.
#
# Builds the app, boots the real relay on a scratch database and free ports serving that build (BUZZ_WEB_DIR = the
# app's dist, BUZZ_WEB_SPA=full) with the hosted terms of use, privacy note and age box on (as the pilot server has
# them), and runs app/tests/e2e-real/: Start and the week's update (start.spec.ts), and a stranger joining from a
# project's link with the founder accepting (join.spec.ts), each counted against plan v2's press budgets. Nothing is
# mocked: real signed records, the server's own checks, real Postgres reads.
#
# It never runs cargo, which matters on a shared machine. It
# uses the relay already built at target/debug/buzz-relay (or RELAY_BIN) and stops with exit 2 when there is none.
# The relay is hard-linked (or copied) into the run's own folder first, so a build replacing it mid-run changes nothing.
#
# It starts Postgres and Redis itself when they are not already answering, and stops only what it started. Every key is
# made for the run (the relay's with openssl, each person's by the app) and none is written to disk.
#
# ⚠️  DEV ONLY. Uses its own database, dropped on exit; the app build goes to a temporary folder, removed on exit.
#
# Usage:  scripts/app-real-loop-e2e.sh [playwright args]        e.g. scripts/app-real-loop-e2e.sh -g "joins"
# Env:    KEEP_DB=1 (keep the scratch database and print its address), RELAY_BIN=<file> (another relay build),
#         POSTGRES_ADMIN_URL, REDIS_URL, RUN_TIMEOUT (seconds for the browser run; default 600),
#         PW_CHROMIUM_PATH / PW_CHROMIUM_EXTRA_ARGS (a Chromium other than the pinned one), RELAY_LOG_COPY=<file>
# Exit:   0 every journey passed; 1 a journey failed (Playwright's own code); 2 the world could not be set up

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
step() { printf '\033[36m[app-real-loop]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[app-real-loop] %s\033[0m\n' "$*" >&2; exit 2; }

ADMIN_URL="${POSTGRES_ADMIN_URL:-postgres://buzz:buzz_dev@127.0.0.1:5432/postgres}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
RUN_TIMEOUT="${RUN_TIMEOUT:-600}"
RELAY_BIN="${RELAY_BIN:-target/debug/buzz-relay}"
DB="buzz_app_real_loop_$$"
DB_URL="${ADMIN_URL%/*}/$DB"
STATE="$(mktemp -d)"
APP_DIST="$STATE/app-dist"
RELAY_PID=""
REDIS_PID=""
PG_CLUSTER=""
DB_MADE=""

for tool in psql curl node openssl python3 pnpm; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing tool: $tool"
done
BOUNDED="$(command -v timeout || command -v gtimeout || true)"
[[ -n "$BOUNDED" ]] || fail "missing tool: timeout (or gtimeout, from coreutils)"
# No cargo here: the relay must already be built.
[[ -x "$RELAY_BIN" ]] || fail "no relay at $RELAY_BIN: build it once with cargo (this script never does), or set RELAY_BIN"

free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }
wait_for() {
  local seconds="$1"; shift
  for _ in $(seq 1 "$seconds"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}
stop_pid() {
  local pid="$1"
  [[ -n "$pid" ]] || return 0
  kill "$pid" 2>/dev/null || return 0
  for _ in $(seq 1 50); do kill -0 "$pid" 2>/dev/null || return 0; sleep 0.2; done
  kill -9 "$pid" 2>/dev/null || true
}

cleanup() {
  local code=$?
  trap - EXIT
  stop_pid "$RELAY_PID"
  if [[ -n "$DB_MADE" && "${KEEP_DB:-}" == "1" ]]; then
    echo "[app-real-loop] kept the scratch database: $DB_URL (drop it with: psql \"$ADMIN_URL\" -c 'drop database $DB with (force)')" >&2
  elif [[ -n "$DB_MADE" ]]; then
    psql "$ADMIN_URL" -qc "drop database if exists $DB with (force)" >/dev/null 2>&1
  fi
  stop_pid "$REDIS_PID"
  # shellcheck disable=SC2086
  [[ -n "$PG_CLUSTER" ]] && pg_ctlcluster $PG_CLUSTER stop >/dev/null 2>&1
  [[ -n "${RELAY_LOG_COPY:-}" && -f "$STATE/relay.log" ]] && cp "$STATE/relay.log" "$RELAY_LOG_COPY"
  rm -rf "$STATE"
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

pg_ready() { psql "$ADMIN_URL" -qAtc 'select 1'; }
redis_ready() { [[ "$(redis-cli -u "$REDIS_URL" ping 2>/dev/null)" == "PONG" ]]; }

step "Postgres and Redis"
if ! pg_ready >/dev/null 2>&1; then
  command -v pg_ctlcluster >/dev/null 2>&1 && command -v pg_lsclusters >/dev/null 2>&1 \
    || fail "Postgres is not answering at $ADMIN_URL and there is no pg_ctlcluster to start it with"
  cluster="$(pg_lsclusters -h | awk '$4 == "down" { print $1, $2; exit }')"
  [[ -n "$cluster" ]] || fail "Postgres is not answering at $ADMIN_URL and no stopped cluster was found to start"
  # shellcheck disable=SC2086
  pg_ctlcluster $cluster start || fail "could not start the Postgres cluster $cluster"
  PG_CLUSTER="$cluster"
  wait_for 30 pg_ready || fail "Postgres was started but does not answer at $ADMIN_URL"
fi
if ! redis_ready; then
  command -v redis-server >/dev/null 2>&1 || fail "Redis is not answering at $REDIS_URL and there is no redis-server to start"
  redis_port="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.urlparse(sys.argv[1]).port or 6379)' "$REDIS_URL")"
  redis-server --port "$redis_port" --bind 127.0.0.1 --save "" --appendonly no >"$STATE/redis.log" 2>&1 &
  REDIS_PID=$!
  wait_for 20 redis_ready || { tail -20 "$STATE/redis.log" >&2; fail "Redis was started but does not answer at $REDIS_URL"; }
fi

step "building the app into a temporary folder"
pnpm -C app exec vite build --outDir "$APP_DIST" --emptyOutDir >"$STATE/app-build.log" 2>&1 \
  || { tail -30 "$STATE/app-build.log" >&2; fail "app build failed"; }
[[ -f "$APP_DIST/index.html" ]] || fail "the app build has no index.html"
ln "$RELAY_BIN" "$STATE/buzz-relay" 2>/dev/null || cp "$RELAY_BIN" "$STATE/buzz-relay" || fail "could not take a copy of $RELAY_BIN"

step "a scratch database ($DB)"
psql "$ADMIN_URL" -qc "create database $DB" || fail "could not create the scratch database"
DB_MADE=1

PORT=$(free_port); HEALTH=$(free_port); METRICS=$(free_port)
step "starting the relay on :$PORT (open, with the hosted terms, privacy note and age box)"
env DATABASE_URL="$DB_URL" REDIS_URL="$REDIS_URL" BUZZ_AUTO_MIGRATE=true \
  BUZZ_RELAY_PRIVATE_KEY="$(openssl rand -hex 32)" \
  BUZZ_BIND_ADDR="127.0.0.1:$PORT" BUZZ_RELAY_URL="ws://localhost:$PORT" RELAY_URL="ws://localhost:$PORT" \
  BUZZ_HEALTH_PORT="$HEALTH" BUZZ_METRICS_PORT="$METRICS" \
  BUZZ_WEB_DIR="$APP_DIST" BUZZ_WEB_SPA=full BUZZ_MEDIA_BASE_URL="http://localhost:$PORT/media" \
  BUZZ_REQUIRE_RELAY_MEMBERSHIP=false BUZZ_GIT_CONFORMANCE_PROBE=false \
  BUZZ_TERMS_OF_SERVICE_MARKDOWN="$(cat docs/policies/TERMS-DRAFT.md)" \
  BUZZ_PRIVACY_POLICY_MARKDOWN="$(cat docs/policies/PRIVACY-DRAFT.md)" \
  BUZZ_AGE_ATTESTATION_REQUIRED=true \
  BUZZ_RATE_LIMIT_HUMAN_MESSAGES_PER_MIN=600 BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC=2000 \
  BUZZ_NEW_ACCOUNT_POSTS_PER_HOUR=0 BUZZ_NEW_ACCOUNT_PROJECT_RECORDS_PER_DAY=0 \
  "$STATE/buzz-relay" >"$STATE/relay.log" 2>&1 &
RELAY_PID=$!
relay_up() { curl -fsS -m 2 -H 'Accept: application/nostr+json' "http://localhost:$PORT/"; }
for _ in $(seq 1 120); do
  relay_up >/dev/null 2>&1 && break
  kill -0 "$RELAY_PID" 2>/dev/null || { tail -30 "$STATE/relay.log" >&2; fail "the relay exited"; }
  sleep 1
done
relay_up >/dev/null 2>&1 || { tail -30 "$STATE/relay.log" >&2; fail "the relay did not come up in two minutes"; }

# The server answers only for hosts it knows (fail-closed host binding): this run's address is one.
psql "$DB_URL" -qc "insert into communities (host) values ('localhost:$PORT') on conflict ((lower(host))) do nothing" \
  || fail "could not add this run's address to the server's communities"
# It serves the app: the shell, and the built files under /assets/.
curl -fsS -m 5 -H 'Accept: text/html' "http://localhost:$PORT/welcome" >"$STATE/page.html" 2>&1 || true
grep -q '<div id="root"' "$STATE/page.html" \
  || { head -c 600 "$STATE/page.html" >&2; echo >&2; fail "the relay does not serve the app's page"; }

step "running the app's journeys (up to ${RUN_TIMEOUT}s)"
cd app
env BUZZ_REAL_RELAY_URL="http://localhost:$PORT" \
  "$BOUNDED" "$RUN_TIMEOUT" node_modules/.bin/playwright test --config=playwright.real-relay.config.ts \
  --reporter=list --trace off "$@"
code=$?
cd "$REPO_ROOT"
if [[ $code -eq 0 ]]; then
  rm -rf app/test-results/playwright-real
  step "every journey passed"
  exit 0
fi
[[ $code -eq 124 ]] && printf '\033[31m[app-real-loop] the browser run did not finish in %ss\033[0m\n' "$RUN_TIMEOUT" >&2
printf '\033[31m[app-real-loop] a journey failed (exit %s). The relay'"'"'s last lines:\033[0m\n' "$code" >&2
grep -v '"level":"DEBUG"' "$STATE/relay.log" | tail -15 >&2
exit 1
