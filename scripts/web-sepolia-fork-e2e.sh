#!/usr/bin/env bash
#
# scripts/web-sepolia-fork-e2e.sh — the same small economy as web-economy-e2e.sh, on a FORK OF SEPOLIA.
#
# Where the dev chain places its own copies of the sale factory and Permit2 and a mock USDC, this one uses what Sepolia
# really has: Uniswap's auction factory, Permit2 and Circle's USDC, with our summoner and launch kit deployed on top by the
# same script that deploys them to Sepolia (`scripts/sepolia-deploy.sh`). Wallets are funded by writing USDC balances into
# the fork's storage, since the real USDC has no open mint. Nothing public changes: the fork is a local anvil.
#
# Boots (all throwaway, all killed on exit): the Sepolia fork with the launch kit on it, a scratch Postgres database with
# the real relay in front of it (self-serve communities, wallet sign-in on chain 11155111), and the web app built against
# both. Then web/tests/e2e-real/economy.spec.ts plays a founder, a labor
# contributor and a capital contributor, each in a browser of their own with a brand-new Nostr account and a brand-new
# private-key wallet, from the first click to the money moving. Nothing is mocked: real signed requests, real database
# rows, real WebSockets, real transactions.
#
# ⚠️  DEV ONLY. Needs Postgres and Redis running (see `just services`) and foundry (forge, cast, anvil). Anvil's public dev
# key is used once, to pay the faucet; every person in the story has a key of their own.
#
# Usage:  scripts/web-sepolia-fork-e2e.sh [playwright args]
# Env:    SEPOLIA_RPC_URL (default: a public node), ANVIL_PORT, POSTGRES_ADMIN_URL, SKIP_BUILD=1 (reuse web/dist and
#         target/debug/buzz-relay)

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
# shellcheck source=/dev/null
. "$REPO_ROOT/bin/activate-hermit" >/dev/null 2>&1 || true
export PATH="${FOUNDRY_BIN:-}:${HOME}/.foundry/bin:${PATH}"
step() { printf '\033[36m[web-sepolia-fork]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[web-sepolia-fork] %s\033[0m\n' "$*" >&2; exit 1; }
for tool in forge cast anvil node psql; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing tool: $tool (set FOUNDRY_BIN for foundry)"
done

ADMIN_URL="${POSTGRES_ADMIN_URL:-postgres://buzz:buzz_dev@localhost:5432/postgres}"
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("",0));print(s.getsockname()[1]);s.close()'; }
PORT=$(free_port); HEALTH=$(free_port); METRICS=$(free_port)
ANVIL_PORT="${ANVIL_PORT:-$((18000 + RANDOM % 1000))}"
RPC="http://127.0.0.1:${ANVIL_PORT}"
DB="buzz_sepfork_e2e_$$"
DB_URL="${ADMIN_URL%/*}/$DB"
STATE="$(mktemp -d)"
DEPLOYMENTS="$REPO_ROOT/contracts/deployments"
BACKUP="$(mktemp -d)"
RELAY_PID=""
ANVIL_PID=""
SEPOLIA_CHAIN_ID=11155111
USDC=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238
FORK_URL="${SEPOLIA_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}"
ANVIL_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80

# The kit deploy writes a tracked manifest for chain 11155111 and a broadcast record. Put the tree back.
MANIFEST="$DEPLOYMENTS/dao-launch-kit-${SEPOLIA_CHAIN_ID}.json"
[[ -f "$MANIFEST" ]] && cp -p "$MANIFEST" "$BACKUP/manifest.json"
cleanup() {
  [[ -n "$RELAY_PID" ]] && kill "$RELAY_PID" 2>/dev/null || true
  [[ -n "$ANVIL_PID" ]] && kill "$ANVIL_PID" 2>/dev/null || true
  lsof -ti "tcp:${ANVIL_PORT}" 2>/dev/null | xargs kill 2>/dev/null || true
  rm -f "$MANIFEST"; [[ -f "$BACKUP/manifest.json" ]] && cp -p "$BACKUP/manifest.json" "$MANIFEST"
  rm -rf "$REPO_ROOT/contracts/broadcast/DeployLaunchKit.s.sol/${SEPOLIA_CHAIN_ID}"
  psql "$ADMIN_URL" -qc "drop database if exists $DB with (force)" >/dev/null 2>&1 || true
  rm -rf "$STATE" "$BACKUP"
}
trap cleanup EXIT

if lsof -ti tcp:4173 >/dev/null 2>&1; then
  fail "port 4173 is already serving something: a stale preview would run an old build (lsof -ti tcp:4173 | xargs kill)"
fi

step "forking Sepolia into a local anvil on ${RPC}"
# A few blocks behind the head: a public node answers from several backends, and the newest block is not on all of them yet
# ("block not found" while the fork is being made).
HEAD_BLOCK="$(cast block-number --rpc-url "$FORK_URL" 2>/dev/null || true)"
[[ "$HEAD_BLOCK" =~ ^[0-9]+$ ]] || fail "could not read the head of $FORK_URL"
# --prune-history=500: the last 500 blocks' state stays in memory (about what anvil keeps there anyway) and none goes to
# disk. Without it anvil spills older state to ~/.foundry/anvil/tmp (gigabytes on a long run) and leaves it there however
# it is stopped, SIGINT included.
anvil --fork-url "$FORK_URL" --fork-block-number "$((HEAD_BLOCK - 10))" --port "$ANVIL_PORT" --prune-history=500 --silent >"$STATE/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 60); do
  [[ "$(cast chain-id --rpc-url "$RPC" 2>/dev/null || true)" == "$SEPOLIA_CHAIN_ID" ]] && break
  kill -0 "$ANVIL_PID" 2>/dev/null || { tail -20 "$STATE/anvil.log"; fail "anvil exited"; }
  sleep 1
done
[[ "$(cast chain-id --rpc-url "$RPC")" == "$SEPOLIA_CHAIN_ID" ]] || fail "the fork did not come up as Sepolia"
step "deploying the summoner and the launch kit, as the Sepolia deploy script does"
(cd contracts && FOUNDRY_LINT_LINT_ON_BUILD=false forge build >/dev/null) || fail "forge build failed"
(cd contracts && PRIVATE_KEY="$ANVIL_KEY" forge script script/DeployLaunchKit.s.sol --rpc-url "$RPC" --broadcast >"$STATE/deploy.out" 2>&1) \
  || { tail -30 "$STATE/deploy.out"; fail "the kit deploy failed"; }
manifest_role() {
  node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log((m.roles ?? []).find((r) => r.role === process.argv[2])?.address ?? "");
  ' "$1" "$2"
}
KIT="$(manifest_role "$MANIFEST" launch-kit)"
# Where the chain's history starts for this app: the block the deploy ran at. Sepolia's real node refuses an event read
# from block 0 (a range over 50,000 blocks), so the web build is told where to start.
FROM_BLOCK="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).block ?? "")' "$MANIFEST")"
[[ "$FROM_BLOCK" =~ ^[0-9]+$ ]] || fail "the manifest names no deploy block"
CURRENCY="$USDC"
[[ -n "$KIT" ]] || fail "the deploy did not report a kit"
step "kit ${KIT}  currency ${CURRENCY} (Circle's USDC, as Sepolia has it)"

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app against that chain, and the relay"
  (cd web && VITE_LAUNCHPAD_CHAIN_ID="$SEPOLIA_CHAIN_ID" VITE_CHAIN_RPC_URL="$RPC" \
    VITE_DAO_LAUNCH_KITS="{\"${SEPOLIA_CHAIN_ID}\":\"${KIT}\"}" VITE_HISTORY_FROM_BLOCKS="{\"${SEPOLIA_CHAIN_ID}\":${FROM_BLOCK}}" node_modules/.bin/vite build >/dev/null 2>&1) || fail "web build failed"
  cargo build -q -p buzz-relay || fail "relay build failed"
fi
[[ -x target/debug/buzz-relay ]] || fail "no target/debug/buzz-relay (build it, or unset SKIP_BUILD)"
[[ -f web/dist/index.html ]] || fail "no web/dist (build it, or unset SKIP_BUILD)"

step "a scratch database (${DB})"
psql "$ADMIN_URL" -qc "create database $DB" || fail "could not create the scratch database (is Postgres running?)"

step "starting the relay on :${PORT}: its own community at that address, self-serve communities on, wallet sign-in on chain 11155111"
if [[ -f .env ]]; then set -a; source .env; set +a; fi
DATABASE_URL="$DB_URL" BUZZ_AUTO_MIGRATE=true BUZZ_RELAY_PRIVATE_KEY="$(openssl rand -hex 32)" \
  BUZZ_BIND_ADDR="0.0.0.0:$PORT" RELAY_URL="ws://localhost:$PORT" BUZZ_RELAY_URL="ws://localhost:$PORT" \
  BUZZ_HEALTH_PORT="$HEALTH" BUZZ_METRICS_PORT="$METRICS" \
  BUZZ_WEB_DIR=./web/dist BUZZ_WEB_SPA=full \
  RELAY_OPERATOR_API_ORIGIN="http://localhost:$PORT" BUZZ_SELF_SERVE_COMMUNITY_DOMAIN="localhost:$PORT" \
  BUZZ_REQUIRE_RELAY_MEMBERSHIP=false BUZZ_PUBLIC_COMMUNITY_DIRECTORY=1 \
  BUZZ_EVM_AUTH=1 BUZZ_EVM_CHAIN_ID="$SEPOLIA_CHAIN_ID" BUZZ_EVM_RPC_URL="$RPC" \
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

# A fork reads its state from a public node as it goes, so every decision takes about ten times as long as on a local chain.
step "running the browser spec"
cd web
BUZZ_REAL_RELAY_URL="http://localhost:$PORT" E2E_INVITE_PORT="$PORT" \
  E2E_ANVIL_URL="$RPC" E2E_CURRENCY="$CURRENCY" E2E_LAUNCH_KIT="$KIT" E2E_CURRENCY_FUNDING=storage \
  E2E_TIMEOUT_MS="${E2E_TIMEOUT_MS:-1800000}" \
  node_modules/.bin/playwright test --config=playwright.real-relay.config.ts tests/e2e-real/economy.spec.ts --reporter=list --retries=0 "$@"
