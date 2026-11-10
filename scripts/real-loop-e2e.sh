#!/usr/bin/env bash
#
# scripts/real-loop-e2e.sh — a project's whole loop in the BROWSER and from the command line, against a REAL server.
#
# Boots the real relay on a scratch database and free ports, serving the real web build, then runs
# web/tests/e2e-real/project-loop.spec.ts: three people in browsers of their own (one signs up, one signs in with a
# saved key, one is already signed in), a fourth who only uses the real `buzz` command line, and a stranger with only
# a socket. Quick Start, weekly updates and their promises, a missed goal, a help request with offers from the web and
# the CLI, Help found / Reopen / Withdraw, tasks from offer to confirmed work, the server's own rules about who may
# sign what, reads by project past 500 other records, the project's boards, a bookmark, a reply's page and Home's side
# panel. Nothing is mocked: real signed records, the server's own checks, real Postgres reads.
#
# It starts Postgres and Redis itself when they are not already answering (a Debian/Ubuntu cluster through
# pg_ctlcluster, redis-server from PATH), and stops only what it started. No media store is started: nothing in this
# run uploads a file, and the relay runs without one.
#
# Every key is made for the run (the relay's with openssl, each person's in the spec) and none is written to disk.
#
# ⚠️  DEV ONLY. Uses its own database, dropped on exit.
#
# Usage:  scripts/real-loop-e2e.sh [playwright args]         e.g. scripts/real-loop-e2e.sh -g "Quick Start"
# Env:    SKIP_BUILD=1 (reuse the web build, target/debug/buzz-relay and target/debug/buzz),
#         WEB_DIST (where the web build goes; default target/web-real-loop), POSTGRES_ADMIN_URL, REDIS_URL,
#         PW_CHROMIUM_PATH / PW_CHROMIUM_EXTRA_ARGS (a Chromium other than the pinned one; see the Playwright config),
#         E2E_SHOTS=<dir> (save a few screenshots), RUN_TIMEOUT (seconds for the browser run; default 900)
# Exit:   0 every flow passed; 1 a flow failed (Playwright's own code); 2 the world could not be set up

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
step() { printf '\033[36m[real-loop]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[real-loop] %s\033[0m\n' "$*" >&2; exit 2; }

ADMIN_URL="${POSTGRES_ADMIN_URL:-postgres://buzz:buzz_dev@127.0.0.1:5432/postgres}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
WEB_DIST="${WEB_DIST:-$REPO_ROOT/target/web-real-loop}"
RUN_TIMEOUT="${RUN_TIMEOUT:-900}"
DB="buzz_real_loop_$$"
DB_URL="${ADMIN_URL%/*}/$DB"
STATE="$(mktemp -d)"
RELAY_PID=""
REDIS_PID=""
PG_CLUSTER=""   # "<version> <name>" of a cluster this run started
DB_MADE=""

for tool in psql curl node openssl python3; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing tool: $tool"
done
BOUNDED="$(command -v timeout || command -v gtimeout || true)"
[[ -n "$BOUNDED" ]] || fail "missing tool: timeout (or gtimeout, from coreutils)"
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }
# Wait up to $1 seconds for the rest of the line to succeed.
wait_for() {
  local seconds="$1"; shift
  for _ in $(seq 1 "$seconds"); do "$@" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}
stop_pid() { # ask, wait up to 10 s, then insist
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
  [[ -n "$DB_MADE" ]] && psql "$ADMIN_URL" -qc "drop database if exists $DB with (force)" >/dev/null 2>&1
  stop_pid "$REDIS_PID"
  # shellcheck disable=SC2086
  [[ -n "$PG_CLUSTER" ]] && pg_ctlcluster $PG_CLUSTER stop >/dev/null 2>&1
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
    || fail "Postgres is not answering at $ADMIN_URL and there is no pg_ctlcluster to start it with (see \`just services\`)"
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

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app into $WEB_DIST, the relay and the command line"
  pnpm -C web exec vite build --outDir "$WEB_DIST" --emptyOutDir >"$STATE/web-build.log" 2>&1 \
    || { tail -30 "$STATE/web-build.log" >&2; fail "web build failed"; }
  cargo build -q -p buzz-relay -p buzz-cli || fail "relay or command-line build failed"
fi
[[ -x target/debug/buzz-relay ]] || fail "no target/debug/buzz-relay (build it, or unset SKIP_BUILD)"
[[ -x target/debug/buzz ]] || fail "no target/debug/buzz (build it, or unset SKIP_BUILD)"
[[ -f "$WEB_DIST/index.html" ]] || fail "no web build in $WEB_DIST (build it, or unset SKIP_BUILD)"
# Copies, so another build replacing the binaries mid-run cannot change what is running.
cp target/debug/buzz-relay "$STATE/buzz-relay"
cp target/debug/buzz "$STATE/buzz"

step "a scratch database ($DB)"
psql "$ADMIN_URL" -qc "create database $DB" || fail "could not create the scratch database"
DB_MADE=1

PORT=$(free_port); HEALTH=$(free_port); METRICS=$(free_port)
step "starting the relay on :$PORT"
# The limits are raised because three browsers, a command line and a seed share one minute, not because any step
# needs it: each person's own writes stay far under the defaults except the seed, which the spec spreads over four
# writers. Membership is open, as the default server is: anyone who signs up may post.
env DATABASE_URL="$DB_URL" REDIS_URL="$REDIS_URL" BUZZ_AUTO_MIGRATE=true \
  BUZZ_RELAY_PRIVATE_KEY="$(openssl rand -hex 32)" \
  BUZZ_BIND_ADDR="127.0.0.1:$PORT" BUZZ_RELAY_URL="ws://localhost:$PORT" RELAY_URL="ws://localhost:$PORT" \
  BUZZ_HEALTH_PORT="$HEALTH" BUZZ_METRICS_PORT="$METRICS" \
  BUZZ_WEB_DIR="$WEB_DIST" BUZZ_WEB_SPA=full BUZZ_MEDIA_BASE_URL="http://localhost:$PORT/media" \
  BUZZ_REQUIRE_RELAY_MEMBERSHIP=false BUZZ_GIT_CONFORMANCE_PROBE=false \
  BUZZ_RATE_LIMIT_HUMAN_MESSAGES_PER_MIN=600 BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC=2000 \
  BUZZ_NEW_ACCOUNT_POSTS_PER_HOUR=0 \
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

step "running the browser spec and the command-line steps (up to ${RUN_TIMEOUT}s)"
cd web
env BUZZ_REAL_RELAY_URL="http://localhost:$PORT" BUZZ_BIN="$STATE/buzz" \
  "$BOUNDED" "$RUN_TIMEOUT" node_modules/.bin/playwright test --config=playwright.real-relay.config.ts \
  tests/e2e-real/project-loop.spec.ts --reporter=list --trace off "$@"
code=$?
cd "$REPO_ROOT"
if [[ $code -eq 0 ]]; then
  step "every flow passed"
  exit 0
fi
[[ $code -eq 124 ]] && printf '\033[31m[real-loop] the browser run did not finish in %ss\033[0m\n' "$RUN_TIMEOUT" >&2
printf '\033[31m[real-loop] a flow failed (exit %s). The relay'"'"'s last lines:\033[0m\n' "$code" >&2
grep -v '"level":"DEBUG"' "$STATE/relay.log" | tail -15 >&2
exit 1
