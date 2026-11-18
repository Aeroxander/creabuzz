#!/usr/bin/env bash
#
# scripts/web-economy-e2e.sh — a small economy, run by several people AT ONCE in real browsers, on a REAL server and a
# REAL chain.
#
# Boots (all throwaway, all killed on exit): a dev chain (the Summoner, the sale factory, Permit2, the dev USDC and the
# launch kit), a scratch Postgres database with the real relay in front of it (self-serve communities, wallet sign-in on
# the chain's id), and the web app built against both. Then web/tests/e2e-real/economy.spec.ts plays a founder, a labor
# contributor and a capital contributor, each in a browser of their own with a brand-new Nostr account and a brand-new
# private-key wallet, from the first click to the money moving. Nothing is mocked: real signed requests, real database
# rows, real WebSockets, real transactions.
#
# ⚠️  DEV ONLY. Needs Postgres and Redis running (see `just services`) and foundry (forge, cast, anvil). Anvil's public dev
# key is used once, to pay the faucet; every person in the story has a key of their own.
#
# Usage:  scripts/web-economy-e2e.sh [playwright args]
# Env:    ANVIL_PORT, POSTGRES_ADMIN_URL, SKIP_BUILD=1 (reuse web/dist and target/debug/buzz-relay)

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=/dev/null
. "$REPO_ROOT/bin/activate-hermit" >/dev/null 2>&1 || true
export PATH="${FOUNDRY_BIN:-}:${HOME}/.foundry/bin:${PATH}"
step() { printf '\033[36m[web-economy]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[web-economy] %s\033[0m\n' "$*" >&2; exit 1; }
for tool in forge cast anvil node psql; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing tool: $tool (set FOUNDRY_BIN for foundry)"
done

ADMIN_URL="${POSTGRES_ADMIN_URL:-postgres://buzz:buzz_dev@localhost:5432/postgres}"
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1]);s.close()'; }
PORT=$(free_port); HEALTH=$(free_port); METRICS=$(free_port)
ANVIL_PORT="${ANVIL_PORT:-$((18000 + RANDOM % 1000))}"
RPC="http://127.0.0.1:${ANVIL_PORT}"
DB="buzz_economy_e2e_$$"
DB_URL="${ADMIN_URL%/*}/$DB"
STATE="$(mktemp -d)"
DEPLOYMENTS="$REPO_ROOT/contracts/deployments"
BACKUP="$(mktemp -d)"
RELAY_PID=""

# The dev chain rewrites the tracked deployment manifests (new transaction hashes every run). Put them back.
cp -p "$DEPLOYMENTS"/*.json "$BACKUP"/ 2>/dev/null || true
# Stop the anvil this run started, and nothing else: the pid its own dev-chain recorded, and only while that pid is still an anvil
# on this run's port. Nothing is ever stopped because it happens to listen on a port (a stranger's node on a colliding port is not ours).
stop_own_anvil() {
  local pid
  pid="$(cat "$STATE/anvil.pid" 2>/dev/null || true)"
  [[ -n "$pid" ]] || return 0
  if ps -o command= -p "$pid" 2>/dev/null | grep -Eq "anvil.* --port[ =]${ANVIL_PORT}( |\$)"; then
    kill "$pid" 2>/dev/null || true
  fi
}
cleanup() {
  [[ -n "$RELAY_PID" ]] && kill "$RELAY_PID" 2>/dev/null || true
  RPC_URL="$RPC" STATE_DIR="$STATE" ./scripts/dev-chain.sh down >/dev/null 2>&1 || true
  # `dev-chain.sh down` can leave the node running: stop the one this run started, by its recorded pid.
  stop_own_anvil
  psql "$ADMIN_URL" -qc "drop database if exists $DB with (force)" >/dev/null 2>&1 || true
  for f in "$BACKUP"/*.json; do [[ -f "$f" ]] && cp -p "$f" "$DEPLOYMENTS/$(basename "$f")"; done
  rm -rf "$STATE" "$BACKUP"
}
trap cleanup EXIT

if lsof -ti tcp:4173 >/dev/null 2>&1; then
  fail "port 4173 is already serving something: a stale preview would run an old build (lsof -ti tcp:4173 | xargs kill)"
fi

step "booting a dev chain on ${RPC}"
if ! RPC_URL="$RPC" STATE_DIR="$STATE" ./scripts/dev-chain.sh >"$STATE/dev-chain.out" 2>&1; then
  tail -60 "$STATE/dev-chain.out"; fail "dev-chain failed"
fi
manifest_role() {
  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log((m.roles ?? []).find((r) => r.role === process.argv[2])?.address ?? "");
  ' "$1" "$2"
}
KIT="$(manifest_role "$DEPLOYMENTS/dao-launch-kit-31337.json" launch-kit)"
CURRENCY="$(manifest_role "$DEPLOYMENTS/dev-currency-31337.json" currency)"
[[ -n "$KIT" && -n "$CURRENCY" ]] || fail "the dev chain did not report a kit and a currency"
step "kit ${KIT}  currency ${CURRENCY}"

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app against that chain, and the relay"
  (cd web && VITE_LOCAL_USDC="$CURRENCY" VITE_LAUNCHPAD_CHAIN_ID=31337 VITE_CHAIN_RPC_URL="$RPC" \
    VITE_DAO_LAUNCH_KITS="{\"31337\":\"${KIT}\"}" node_modules/.bin/vite build >/dev/null 2>&1) || fail "web build failed"
  cargo build -q -p buzz-relay || fail "relay build failed"
fi
[[ -x target/debug/buzz-relay ]] || fail "no target/debug/buzz-relay (build it, or unset SKIP_BUILD)"
[[ -f web/dist/index.html ]] || fail "no web/dist (build it, or unset SKIP_BUILD)"

step "a scratch database (${DB})"
psql "$ADMIN_URL" -qc "create database $DB" || fail "could not create the scratch database (is Postgres running?)"

step "starting the relay on :${PORT}: its own community at that address, self-serve communities on, wallet sign-in on chain 31337"
if [[ -f .env ]]; then set -a; source .env; set +a; fi
DATABASE_URL="$DB_URL" BUZZ_AUTO_MIGRATE=true BUZZ_RELAY_PRIVATE_KEY="$(openssl rand -hex 32)" \
  BUZZ_BIND_ADDR="0.0.0.0:$PORT" RELAY_URL="ws://localhost:$PORT" BUZZ_RELAY_URL="ws://localhost:$PORT" \
  BUZZ_HEALTH_PORT="$HEALTH" BUZZ_METRICS_PORT="$METRICS" \
  BUZZ_WEB_DIR=./web/dist BUZZ_WEB_SPA=full \
  RELAY_OPERATOR_API_ORIGIN="http://localhost:$PORT" BUZZ_SELF_SERVE_COMMUNITY_DOMAIN="localhost:$PORT" \
  BUZZ_REQUIRE_RELAY_MEMBERSHIP=false BUZZ_PUBLIC_COMMUNITY_DIRECTORY=1 \
  BUZZ_EVM_AUTH=1 BUZZ_EVM_CHAIN_ID=31337 BUZZ_EVM_RPC_URL="$RPC" \
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
  E2E_ANVIL_URL="$RPC" E2E_CURRENCY="$CURRENCY" E2E_LAUNCH_KIT="$KIT" \
  node_modules/.bin/playwright test --config=playwright.real-relay.config.ts tests/e2e-real/economy.spec.ts --reporter=list --retries=0 "$@"
