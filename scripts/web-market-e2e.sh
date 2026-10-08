#!/usr/bin/env bash
#
# scripts/web-market-e2e.sh — the market price in the WEB app, against a REAL local chain.
#
# Builds the `cli-market-e2e.sh` world (a project's Shares on LBAMM), makes three trades, starts the price indexer, builds
# the web app pointed at it, and runs web/tests/e2e/launchpad-market.spec.ts: the launch page's chart shows the traded
# prices, and a `$NEB` in a post shows the last trade.
#
# ⚠️  DEV ONLY. A local chain; LBAMM is evaluation-only (see docs/v3-review/LBAMM.md).
#
# Usage:  LBAMM_DIR=/path/to/lbamm-examples scripts/web-market-e2e.sh [playwright args]
# Env:    LBAMM_DIR (required), ANVIL_PORT, BUZZ_BIN, INDEXER_PORT

WORLD_NAME=web-market
# shellcheck source=lib/market-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/market-world.sh"
trap 'stop_indexer; cleanup' EXIT

world_up
lbamm_up
world_launch_with_lock
world_market_seed

step "a buyer buys, sells some back and buys again"
trade $KEY_REVIEWER1 "$CURRENCY" "$SHARES" 1000 6 1 >/dev/null || fail "the buy failed"
trade $KEY_REVIEWER1 "$SHARES" "$CURRENCY" 10000 18 1 >/dev/null || fail "the sale failed"
trade $KEY_REVIEWER1 "$CURRENCY" "$SHARES" 500 6 1 >/dev/null || fail "the second buy failed"

start_indexer

if lsof -ti tcp:4173 >/dev/null 2>&1; then
  fail "port 4173 is already serving something: a stale preview would run an old build (lsof -ti tcp:4173 | xargs kill)"
fi
cd "$REPO_ROOT/web"
step "building the web app, pointed at the price service"
VITE_LAUNCHPAD_CHAIN_ID=31337 VITE_LOCAL_USDC="$CURRENCY" VITE_PRICE_INDEXER_URL="http://127.0.0.1:${INDEXER_PORT}" \
  node_modules/.bin/vite build >/dev/null 2>&1 || fail "web build failed"
step "running the browser spec"
E2E_ANVIL_URL="$RPC" E2E_SHARES="$SHARES" E2E_CURRENCY="$CURRENCY" E2E_DAO="$DAO" \
  node_modules/.bin/playwright test tests/e2e/launchpad-market.spec.ts --project=smoke --reporter=list "$@"
