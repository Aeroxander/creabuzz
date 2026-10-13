#!/usr/bin/env bash
#
# scripts/web-invite-only-e2e.sh — private communities and invite links, in the BROWSER, against a REAL server.
#
# Boots the real relay on a scratch database and a free port with self-serve communities on (and the server-wide
# membership switch OFF, so what is tested is each community's own setting), then runs
# web/tests/e2e-real/invite-only.spec.ts: an owner makes a community (private by default), a stranger is turned away, an
# invite link lets exactly one person in, the same link is refused for a second, the owner opens the community and the
# stranger gets in, and closes it again. Nothing is mocked: real signed requests, real database rows, real WebSocket
# sign-in.
#
# ⚠️  DEV ONLY. Needs Postgres and Redis running (see `just services`). Uses its own database, dropped on exit.
#
# Usage:  scripts/web-invite-only-e2e.sh [playwright args]
# Env:    SKIP_BUILD=1 (reuse web/dist and target/debug/buzz-relay), POSTGRES_ADMIN_URL

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
step() { printf '\033[36m[web-invite-only]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[web-invite-only] %s\033[0m\n' "$*" >&2; exit 1; }

ADMIN_URL="${POSTGRES_ADMIN_URL:-postgres://buzz:buzz_dev@localhost:5432/postgres}"
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1]);s.close()'; }
PORT=$(free_port); HEALTH=$(free_port); METRICS=$(free_port)
DB="buzz_inviteonly_e2e_$$"
DB_URL="${ADMIN_URL%/*}/$DB"
STATE="$(mktemp -d)"
RELAY_PID=""
cleanup() {
  [[ -n "$RELAY_PID" ]] && kill "$RELAY_PID" 2>/dev/null || true
  psql "$ADMIN_URL" -qc "drop database if exists $DB with (force)" >/dev/null 2>&1 || true
  rm -rf "$STATE"
}
trap cleanup EXIT

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app and the relay"
  pnpm -C web build >/dev/null 2>&1 || fail "web build failed"
  cargo build -q -p buzz-relay || fail "relay build failed"
fi
[[ -x target/debug/buzz-relay ]] || fail "no target/debug/buzz-relay (build it, or unset SKIP_BUILD)"
[[ -f web/dist/index.html ]] || fail "no web/dist (build it, or unset SKIP_BUILD)"

step "a scratch database ($DB)"
psql "$ADMIN_URL" -qc "create database $DB" || fail "could not create the scratch database (is Postgres running?)"

step "starting the relay on :$PORT with self-serve communities on and the server-wide switch off"
# The same service settings the dev relay uses (object storage and so on), then this run's own database, port and key.
if [[ -f .env ]]; then set -a; source .env; set +a; fi
# A throwaway relay signing key: this relay and its database exist only for this run.
DATABASE_URL="$DB_URL" BUZZ_AUTO_MIGRATE=true BUZZ_RELAY_PRIVATE_KEY="$(openssl rand -hex 32)" \
  BUZZ_BIND_ADDR="0.0.0.0:$PORT" BUZZ_RELAY_URL="ws://localhost:$PORT" \
  BUZZ_HEALTH_PORT="$HEALTH" BUZZ_METRICS_PORT="$METRICS" \
  BUZZ_WEB_DIR=./web/dist BUZZ_WEB_SPA=full \
  RELAY_OPERATOR_API_ORIGIN="http://localhost:$PORT" BUZZ_SELF_SERVE_COMMUNITY_DOMAIN="localhost:$PORT" \
  BUZZ_REQUIRE_RELAY_MEMBERSHIP=false BUZZ_PUBLIC_COMMUNITY_DIRECTORY=1 \
  BUZZ_RATE_LIMIT_HUMAN_MESSAGES_PER_MIN=600 BUZZ_RATE_LIMIT_HUMAN_WS_EVENTS_PER_SEC=2000 \
  ./target/debug/buzz-relay >"$STATE/relay.log" 2>&1 &
RELAY_PID=$!
for _ in $(seq 1 120); do
  curl -fsS -m 2 "http://localhost:$PORT/self-serve/communities" 2>/dev/null | grep -q '"enabled":true' && break
  kill -0 "$RELAY_PID" 2>/dev/null || { tail -30 "$STATE/relay.log"; fail "the relay exited"; }
  sleep 1
done
curl -fsS -m 2 "http://localhost:$PORT/self-serve/communities" | grep -q '"enabled":true' \
  || { tail -30 "$STATE/relay.log"; fail "the relay did not come up with self-serve on"; }

step "running the browser spec"
cd web
BUZZ_REAL_RELAY_URL="http://localhost:$PORT" E2E_INVITE_PORT="$PORT" \
  node_modules/.bin/playwright test --config=playwright.real-relay.config.ts tests/e2e-real/invite-only.spec.ts --reporter=list "$@"
