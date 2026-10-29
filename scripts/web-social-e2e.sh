#!/usr/bin/env bash
#
# scripts/web-social-e2e.sh — the social MVP in the BROWSER, against a REAL server.
#
# Boots the real relay on a scratch database at localhost:3199 (the address the real-relay suite and its seed scripts
# use), seeds the community, the people, their follows and posts, and a few launches (`web/tests/e2e-real/seed.mjs`,
# `seed-social.mjs` and `seed-demo.mjs`),
# then runs every social real-server spec: `web/tests/e2e-real/social.spec.ts` (posting, following, votes, replies,
# reposts, quotes, bookmarks, search, notifications, profiles, muting, direct messages, deleting),
# `board-moderation.spec.ts` (a board's moderation and reports, the author told of a removal, a mute on boards), and
# `home-moderation.spec.ts`, `follow-notify.spec.ts` and `media.spec.ts` where they exist. Nothing is mocked: real signed
# requests, real database rows, real WebSocket sign-in. This is the local, automated version of the roadmap's
# three-account social run; it does not replace running it on the hosted server with real people.
#
# HOSTED=1 runs it the way the pilot server runs (deploy/compose, docs/v3-review/PILOT-RUNBOOK.md): the web app built
# contributor-only (VITE_CONTRIBUTOR_ONLY=1, as the Dockerfile does) into its own directory, every community
# invite-only (BUZZ_REQUIRE_RELAY_MEMBERSHIP=true, with the seeded people as members), REST calls only with a signed
# token, unread rooms on, the new-account post limit left at the server's default, and the per-person request limit
# read from deploy/compose/compose.creaton.yml (a value set in the shell wins, as it does for compose). The sale-path
# tests skip themselves there. Without HOSTED=1 the server is loosened for speed, as before.
#
# SOCIAL_FRAME_REPORT=1 also counts what each signed-in account's pages send the server, and prints the busiest five
# seconds per test and for the run (`web/tests/e2e-real/frame-meter.ts`), against the request limit when HOSTED=1.
#
# ⚠️  DEV ONLY. Needs Postgres and Redis running (see `just services`). Uses its own database, dropped on exit.
#
# Usage:  scripts/web-social-e2e.sh [playwright args]      (scripts/web-social-hosted-e2e.sh is HOSTED=1)
# Env:    HOSTED=1 (as the pilot server runs, above), SOCIAL_FRAME_REPORT=1 (the frame meter, above),
#         SKIP_BUILD=1 (reuse the web build and target/debug/buzz-relay), POSTGRES_ADMIN_URL,
#         WEB_DIST (the web build to serve; default web/dist, or target/web-social-hosted with HOSTED=1; built here
#         unless SKIP_BUILD=1), SPECS (which real-relay specs to run; default every one above that exists),
#         SOCIAL_FRAME_REPORT_FILE (where the meter writes; default target/social-frames.jsonl)

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
step() { printf '\033[36m[web-social]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[web-social] %s\033[0m\n' "$*" >&2; exit 1; }

ADMIN_URL="${POSTGRES_ADMIN_URL:-postgres://buzz:buzz_dev@localhost:5432/postgres}"
HOSTED="${HOSTED:-}"
[[ -z "$HOSTED" || "$HOSTED" == "1" ]] || fail "HOSTED is 1 or unset, not ${HOSTED}"
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1]);s.close()'; }
PORT=3199
HEALTH=$(free_port); METRICS=$(free_port)
DB="buzz_social_e2e_$$"
DB_URL="${ADMIN_URL%/*}/$DB"
if [[ "$HOSTED" == "1" ]]; then
  # Its own directory, so the hosted build never replaces the web/dist other runs serve.
  WEB_DIST="${WEB_DIST:-$REPO_ROOT/target/web-social-hosted}"
else
  WEB_DIST="${WEB_DIST:-$REPO_ROOT/web/dist}"
fi
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

# The pilot server's settings, from the one place they live (deploy/compose). A value set in the shell wins, as it does
# for compose's own ${NAME:-default}.
COMPOSE_CREATON="$REPO_ROOT/deploy/compose/compose.creaton.yml"
compose_default() { # NAME -> the default compose.creaton.yml gives it ("NAME: ${NAME:-value}")
  local value
  value="$(sed -n "s/^ *$1: [$]{$1:-\([^}]*\)}.*$/\1/p" "$COMPOSE_CREATON" | head -1)"
  [[ -n "$value" ]] || fail "deploy/compose/compose.creaton.yml gives no default for $1 (the hosted run reads it from there)"
  printf '%s' "$value"
}
HOSTED_ENV=()
if [[ "$HOSTED" == "1" ]]; then
  WS_EVENTS_PER_SEC="${BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC:-$(compose_default BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC)}"
  MESSAGES_PER_MIN="${BUZZ_RATE_LIMIT_HUMAN_MESSAGES_PER_MIN:-$(compose_default BUZZ_RATE_LIMIT_HUMAN_MESSAGES_PER_MIN)}"
  V1_ENABLED="${BUZZ_V1_ENABLED:-$(compose_default BUZZ_V1_ENABLED)}"
  [[ "$WS_EVENTS_PER_SEC" =~ ^[1-9][0-9]*$ && "$MESSAGES_PER_MIN" =~ ^[1-9][0-9]*$ ]] \
    || fail "the request limits must be whole numbers above 0 (got ${WS_EVENTS_PER_SEC:-nothing} and ${MESSAGES_PER_MIN:-nothing})"
  # deploy/compose/.env.example's production lines, and the owner the seed's dev identity is (seed.sql).
  HOSTED_ENV=(
    BUZZ_REQUIRE_RELAY_MEMBERSHIP=true
    RELAY_OWNER_PUBKEY=e5ebc6cdb579be112e336cc319b5989b4bb6af11786ea90dbe52b5f08d741b34
    BUZZ_REQUIRE_AUTH_TOKEN=true BUZZ_ALLOW_NIP_OA_AUTH=true
    BUZZ_V1_ENABLED="$V1_ENABLED"
    BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC="$WS_EVENTS_PER_SEC"
    BUZZ_RATE_LIMIT_HUMAN_MESSAGES_PER_MIN="$MESSAGES_PER_MIN"
  )
  # Nothing loosened: the new-account post limit stays at the server's default.
else
  HOSTED_ENV=(
    BUZZ_REQUIRE_RELAY_MEMBERSHIP=false
    BUZZ_RATE_LIMIT_HUMAN_MESSAGES_PER_MIN=600 BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC=2000
    BUZZ_NEW_ACCOUNT_POSTS_PER_HOUR=0
  )
fi

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  if [[ "$HOSTED" == "1" ]]; then
    step "building the web app contributor-only, as the hosted image does, into $WEB_DIST; and the relay"
    VITE_CONTRIBUTOR_ONLY=1 pnpm -C web exec vite build --outDir "$WEB_DIST" --emptyOutDir >"$STATE/web-build.log" 2>&1 \
      || { tail -30 "$STATE/web-build.log"; fail "web build failed"; }
  else
    step "building the web app and the relay"
    pnpm -C web exec vite build --outDir "$WEB_DIST" --emptyOutDir >/dev/null 2>&1 || fail "web build failed"
  fi
  cargo build -q -p buzz-relay || fail "relay build failed"
fi
[[ -x target/debug/buzz-relay ]] || fail "no target/debug/buzz-relay (build it, or unset SKIP_BUILD)"
[[ -f "$WEB_DIST/index.html" ]] || fail "no web build in $WEB_DIST (build it, or unset SKIP_BUILD)"
# A copy of the relay, so another build replacing target/debug/buzz-relay mid-run cannot change what is running.
cp target/debug/buzz-relay "$STATE/buzz-relay"

step "a scratch database ($DB)"
psql "$ADMIN_URL" -qc "create database $DB" || fail "could not create the scratch database (is Postgres running?)"

if [[ "$HOSTED" == "1" ]]; then
  step "starting the relay on :$PORT as the pilot server runs: invite-only, ${WS_EVENTS_PER_SEC} requests a second and ${MESSAGES_PER_MIN} writes a minute per person"
else
  step "starting the relay on :$PORT"
fi
if [[ -f .env ]]; then set -a; source .env; set +a; fi
# The hosted run keeps the server's default new-account post limit, whatever the developer's .env says.
if [[ "$HOSTED" == "1" ]]; then unset BUZZ_NEW_ACCOUNT_POSTS_PER_HOUR; fi
# `env` after .env, so this run's settings win over whatever the developer's .env says.
env DATABASE_URL="$DB_URL" BUZZ_AUTO_MIGRATE=true BUZZ_RELAY_PRIVATE_KEY="$(openssl rand -hex 32)" \
  BUZZ_BIND_ADDR="0.0.0.0:$PORT" BUZZ_RELAY_URL="ws://localhost:$PORT" RELAY_URL="ws://localhost:$PORT" \
  BUZZ_HEALTH_PORT="$HEALTH" BUZZ_METRICS_PORT="$METRICS" \
  BUZZ_WEB_DIR="$WEB_DIST" BUZZ_WEB_SPA=full \
  BUZZ_MEDIA_BASE_URL="http://localhost:$PORT/media" \
  "${HOSTED_ENV[@]}" \
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

if [[ "$HOSTED" == "1" ]]; then
  # The server admits members only: a seeded person who is not one would fail later as a confusing empty page.
  people="$(node -e 'const f=require("./tests/e2e-real/.social-fixture.json");const m=require("./tests/e2e-real/.fixture.json");
    console.log([...new Set([...Object.values(f.people),m.ownerPubkey,m.mentionPubkey])].join(" "))')" \
    || fail "could not read the seeded people"
  for pubkey in $people; do
    [[ "$(psql "$DB_URL" -Atc "select count(*) from relay_members m join communities c on c.id = m.community_id
      where lower(c.host) = 'localhost:$PORT' and m.pubkey = '$pubkey'")" == "1" ]] \
      || fail "seeded account $pubkey is not a member of the server (the hosted run admits members only)"
  done
fi

# Every social real-server spec there is (some are added by later work; a missing one is not an error).
DEFAULT_SPECS=()
for spec in social board-moderation home-moderation follow-notify media; do
  [[ -f "tests/e2e-real/$spec.spec.ts" ]] && DEFAULT_SPECS+=("tests/e2e-real/$spec.spec.ts")
done
read -r -a RUN_SPECS <<<"${SPECS:-${DEFAULT_SPECS[*]}}"
[[ ${#RUN_SPECS[@]} -gt 0 ]] || fail "no specs to run"

FRAME_ENV=()
FRAME_FILE="${SOCIAL_FRAME_REPORT_FILE:-$REPO_ROOT/target/social-frames.jsonl}"
if [[ "${SOCIAL_FRAME_REPORT:-}" == "1" ]]; then
  mkdir -p "$(dirname "$FRAME_FILE")"
  : >"$FRAME_FILE"
  FRAME_ENV=(SOCIAL_FRAME_REPORT=1 SOCIAL_FRAME_REPORT_FILE="$FRAME_FILE")
  [[ "$HOSTED" == "1" ]] && FRAME_ENV+=(SOCIAL_WS_EVENTS_PER_SEC="$WS_EVENTS_PER_SEC")
fi

step "running the browser specs: ${RUN_SPECS[*]}"
set +e
env BUZZ_REAL_RELAY_URL="http://localhost:$PORT" DATABASE_URL="$DB_URL" SOCIAL_HOSTED="$HOSTED" \
  ${FRAME_ENV[@]+"${FRAME_ENV[@]}"} \
  node_modules/.bin/playwright test --config=playwright.real-relay.config.ts \
  "${RUN_SPECS[@]}" --reporter=list "$@"
status=$?
set -e
if [[ "${SOCIAL_FRAME_REPORT:-}" == "1" ]]; then
  step "what the pages sent the server (kept in $FRAME_FILE)"
  node tests/e2e-real/frame-report.mjs "$FRAME_FILE" "${WS_EVENTS_PER_SEC:-}" \
    || echo "[frames] report failed; the raw lines are in $FRAME_FILE" >&2
fi
if [[ $status -ne 0 ]]; then
  step "relay log (last 40 lines)"
  tail -40 "$STATE/relay.log"
fi
exit $status
