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
# The server is open by default (anyone who signs up may post). BUZZ_REQUIRE_RELAY_MEMBERSHIP=true runs the same journey
# against an invite-only server, as the pilot server is (deploy/compose/.env.creaton.example): the run makes an owner key,
# each browser gets in through an invite link the owner makes in the People page, the people who only use a socket or the
# command line are added to the member list, and the visitor with no account is shown what such a server gives them (the
# spec says which answers it accepts). Two modes, one spec: `scripts/real-loop-e2e.sh` and
# `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true scripts/real-loop-e2e.sh`.
#
# An invite-only server may let anyone read a public project's record (BUZZ_PUBLIC_PROJECT_READS=true, as Creaton's own
# server does: deploy/compose/.env.creaton.example). With it the visitor with no account must be shown the project's
# record, read only, at both of its shared addresses, and the link must carry a real preview; without it (the default
# here) they must be shown the invite sentence and the plain page. So the invite-only journey is run both ways:
# `BUZZ_REQUIRE_RELAY_MEMBERSHIP=true BUZZ_PUBLIC_PROJECT_READS=true scripts/real-loop-e2e.sh` and the line above.
#
# A second world, the pilot's (E2E_WORLD=pilot): the web app built as the hosted image builds it (VITE_CONTRIBUTOR_ONLY=1)
# and the server with the pilot's terms of use, privacy note and age box on, as docs/policies and
# deploy/compose/.env.creaton.example set them. It runs web/tests/e2e-real/solo-path.spec.ts: a person alone, from Home to
# the first piece of work done, and what the record, the picture and Home say after it. Run it in the three modes above too:
# `E2E_WORLD=pilot scripts/real-loop-e2e.sh`, and with BUZZ_REQUIRE_RELAY_MEMBERSHIP / BUZZ_PUBLIC_PROJECT_READS as above.
#
# ⚠️  DEV ONLY. Uses its own database, dropped on exit.
#
# Usage:  scripts/real-loop-e2e.sh [playwright args]         e.g. scripts/real-loop-e2e.sh -g "Quick Start"
# Env:    BUZZ_REQUIRE_RELAY_MEMBERSHIP=true|false (default false: see above), BUZZ_PUBLIC_PROJECT_READS=true|false
#         (default false: see above), KEEP_DB=1 (keep the scratch database, with the
#         journey's records in it, and print its address; drop it yourself), SKIP_BUILD=1 (reuse the web build, target/debug/buzz-relay and target/debug/buzz),
#         E2E_WORLD=default|pilot (default: default; see above), E2E_SPEC (the spec file to run, under web/tests/e2e-real; default
#         project-loop.spec.ts, or solo-path.spec.ts in the pilot world),
#         WEB_DIST (where the web build goes; default target/web-real-loop), POSTGRES_ADMIN_URL, REDIS_URL,
#         PW_CHROMIUM_PATH / PW_CHROMIUM_EXTRA_ARGS (a Chromium other than the pinned one; see the Playwright config),
#         E2E_SHOTS=<dir> (save a few screenshots), RUN_TIMEOUT (seconds for the browser run; default 900),
#         RELAY_LOG_COPY=<file> (keep the relay's whole log there when the run ends),
#         RELAY_BIN=<file> (run this relay instead of target/debug/buzz-relay, to try a build of your own without
#         replacing the one everyone shares)
# Exit:   0 every flow passed; 1 a flow failed (Playwright's own code); 2 the world could not be set up

set -uo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
step() { printf '\033[36m[real-loop]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[real-loop] %s\033[0m\n' "$*" >&2; exit 2; }

ADMIN_URL="${POSTGRES_ADMIN_URL:-postgres://buzz:buzz_dev@127.0.0.1:5432/postgres}"
REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
WORLD="${E2E_WORLD:-default}"
[[ "$WORLD" == "default" || "$WORLD" == "pilot" ]] \
  || { printf '\033[31m[real-loop] E2E_WORLD is default or pilot, not "%s"\033[0m\n' "$WORLD" >&2; exit 2; }
if [[ "$WORLD" == "pilot" ]]; then
  WEB_DIST="${WEB_DIST:-$REPO_ROOT/target/web-real-loop-pilot}"
  SPEC="${E2E_SPEC:-solo-path.spec.ts}"
else
  WEB_DIST="${WEB_DIST:-$REPO_ROOT/target/web-real-loop}"
  SPEC="${E2E_SPEC:-project-loop.spec.ts}"
fi
RUN_TIMEOUT="${RUN_TIMEOUT:-900}"
DB="buzz_real_loop_$$"
DB_URL="${ADMIN_URL%/*}/$DB"
STATE="$(mktemp -d)"
RELAY_PID=""
REDIS_PID=""
PG_CLUSTER=""   # "<version> <name>" of a cluster this run started
DB_MADE=""
MEMBERSHIP="${BUZZ_REQUIRE_RELAY_MEMBERSHIP:-false}"
[[ "$MEMBERSHIP" == "true" || "$MEMBERSHIP" == "false" ]] \
  || { printf '\033[31m[real-loop] BUZZ_REQUIRE_RELAY_MEMBERSHIP is true or false, not "%s"\033[0m\n' "$MEMBERSHIP" >&2; exit 2; }
PUBLIC_READS="${BUZZ_PUBLIC_PROJECT_READS:-false}"
[[ "$PUBLIC_READS" == "true" || "$PUBLIC_READS" == "false" ]] \
  || { printf '\033[31m[real-loop] BUZZ_PUBLIC_PROJECT_READS is true or false, not "%s"\033[0m\n' "$PUBLIC_READS" >&2; exit 2; }

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
  if [[ -n "$DB_MADE" && "${KEEP_DB:-}" == "1" ]]; then
    echo "[real-loop] kept the scratch database: $DB_URL (drop it with: psql \"$ADMIN_URL\" -c 'drop database $DB with (force)')" >&2
  elif [[ -n "$DB_MADE" ]]; then
    psql "$ADMIN_URL" -qc "drop database if exists $DB with (force)" >/dev/null 2>&1
  fi
  stop_pid "$REDIS_PID"
  # shellcheck disable=SC2086
  [[ -n "$PG_CLUSTER" ]] && pg_ctlcluster $PG_CLUSTER stop >/dev/null 2>&1
  # The relay's whole log, for a run that failed in a way its last lines do not explain.
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

PILOT_BUILD_ENV=()
[[ "$WORLD" == "pilot" ]] && PILOT_BUILD_ENV=(VITE_CONTRIBUTOR_ONLY=1)
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app into $WEB_DIST, the relay and the command line"
  # The pilot world is built as the hosted image builds it: contributor-only.
  env ${PILOT_BUILD_ENV[@]+"${PILOT_BUILD_ENV[@]}"} pnpm -C web exec vite build --outDir "$WEB_DIST" --emptyOutDir >"$STATE/web-build.log" 2>&1 \
    || { tail -30 "$STATE/web-build.log" >&2; fail "web build failed"; }
  cargo build -q -p buzz-relay -p buzz-cli || fail "relay or command-line build failed"
fi
OWN_RELAY="${RELAY_BIN:-}"
RELAY_BIN="${RELAY_BIN:-target/debug/buzz-relay}"
[[ -x "$RELAY_BIN" ]] || fail "no $RELAY_BIN (build it, or unset SKIP_BUILD)"
[[ -x target/debug/buzz ]] || fail "no target/debug/buzz (build it, or unset SKIP_BUILD)"
[[ -f "$WEB_DIST/index.html" ]] || fail "no web build in $WEB_DIST (build it, or unset SKIP_BUILD)"
# Copies, so another build replacing the binaries mid-run cannot change what is running. A relay named with RELAY_BIN is
# the caller's own file, which no build replaces: it is linked when it can be (it is close to 300 MB), else copied.
if [[ -n "$OWN_RELAY" ]] && ln "$RELAY_BIN" "$STATE/buzz-relay" 2>/dev/null; then :; else cp "$RELAY_BIN" "$STATE/buzz-relay"; fi
cp target/debug/buzz "$STATE/buzz"

step "a scratch database ($DB)"
psql "$ADMIN_URL" -qc "create database $DB" || fail "could not create the scratch database"
DB_MADE=1

PORT=$(free_port); HEALTH=$(free_port); METRICS=$(free_port)
step "starting the relay on :$PORT ($([[ "$MEMBERSHIP" == "true" ]] && echo "invite-only: members only" || echo "open: anyone who signs up may post")$([[ "$PUBLIC_READS" == "true" ]] && echo "; anyone may read a public project's record"))"
# The limits are raised because three browsers, a command line and a seed share one minute, not because any step
# needs it: each person's own writes stay far under the defaults except the seed, which the spec spreads over four
# writers. Membership is open unless BUZZ_REQUIRE_RELAY_MEMBERSHIP=true (above): then the server has an owner, whose key
# this run makes and gives the spec, and only members read or post.
OWNER_ENV=()
if [[ "$MEMBERSHIP" == "true" ]]; then
  OWNER_KEY="$(openssl rand -hex 32)"
  OWNER_PUBKEY="$(cd web && node --input-type=module -e \
    'import { getPublicKey } from "nostr-tools/pure"; const k = Uint8Array.from(Buffer.from(process.argv[1], "hex")); console.log(getPublicKey(k))' \
    "$OWNER_KEY")" || fail "could not work out the owner's public key"
  [[ "$OWNER_PUBKEY" =~ ^[0-9a-f]{64}$ ]] || fail "the owner's public key is not 64 hex characters"
  OWNER_ENV=(RELAY_OWNER_PUBKEY="$OWNER_PUBKEY")
fi
# The pilot's sign-up: terms of use, a privacy note and an age box (the same drafts the hosted server is given).
TERMS_ENV=()
if [[ "$WORLD" == "pilot" ]]; then
  TERMS_ENV=(
    BUZZ_TERMS_OF_SERVICE_MARKDOWN="$(cat docs/policies/TERMS-DRAFT.md)"
    BUZZ_PRIVACY_POLICY_MARKDOWN="$(cat docs/policies/PRIVACY-DRAFT.md)"
    BUZZ_AGE_ATTESTATION_REQUIRED=true
  )
fi
env DATABASE_URL="$DB_URL" REDIS_URL="$REDIS_URL" BUZZ_AUTO_MIGRATE=true \
  BUZZ_RELAY_PRIVATE_KEY="$(openssl rand -hex 32)" \
  BUZZ_BIND_ADDR="127.0.0.1:$PORT" BUZZ_RELAY_URL="ws://localhost:$PORT" RELAY_URL="ws://localhost:$PORT" \
  BUZZ_HEALTH_PORT="$HEALTH" BUZZ_METRICS_PORT="$METRICS" \
  BUZZ_WEB_DIR="$WEB_DIST" BUZZ_WEB_SPA=full BUZZ_MEDIA_BASE_URL="http://localhost:$PORT/media" \
  BUZZ_REQUIRE_RELAY_MEMBERSHIP="$MEMBERSHIP" BUZZ_PUBLIC_PROJECT_READS="$PUBLIC_READS" BUZZ_GIT_CONFORMANCE_PROBE=false \
  ${OWNER_ENV[@]+"${OWNER_ENV[@]}"} \
  ${TERMS_ENV[@]+"${TERMS_ENV[@]}"} \
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

SPEC_ENV=(BUZZ_REAL_DATABASE_URL="$DB_URL")
if [[ "$MEMBERSHIP" == "true" ]]; then
  # The owner is the first member, as on a server that has just been set up: they make everyone else's invite. The
  # server may already have made them one when the community was added; either way there must be exactly one row.
  psql "$DB_URL" -qc "insert into relay_members (community_id, pubkey, role)
    select id, '$OWNER_PUBKEY', 'owner' from communities where lower(host) = 'localhost:$PORT'
    on conflict do nothing" \
    || fail "could not make the owner a member of this run's community"
  [[ "$(psql "$DB_URL" -Atc "select count(*) from relay_members m join communities c on c.id = m.community_id
    where lower(c.host) = 'localhost:$PORT' and m.pubkey = '$OWNER_PUBKEY' and m.role = 'owner'")" == "1" ]] \
    || fail "the owner is not this run's community's owner"
  SPEC_ENV+=(E2E_INVITE_ONLY=1 BUZZ_REAL_OWNER_KEY="$OWNER_KEY")
fi
[[ "$PUBLIC_READS" == "true" ]] && SPEC_ENV+=(E2E_PUBLIC_READS=1)

step "running the browser spec and the command-line steps (up to ${RUN_TIMEOUT}s)"
cd web
env BUZZ_REAL_RELAY_URL="http://localhost:$PORT" BUZZ_BIN="$STATE/buzz" ${SPEC_ENV[@]+"${SPEC_ENV[@]}"} \
  "$BOUNDED" "$RUN_TIMEOUT" node_modules/.bin/playwright test --config=playwright.real-relay.config.ts \
  "tests/e2e-real/$SPEC" --reporter=list --trace off "$@"
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
