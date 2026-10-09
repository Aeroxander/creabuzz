#!/usr/bin/env bash
#
# scripts/web-market-journey-e2e.sh — a project's MARKET run entirely from the WEB app, on a REAL local chain with LBAMM.
# No command line.
#
# A project is launched into its own DAO through the kit. Then web/tests/e2e/launchpad-market-journey.spec.ts does the rest in
# a browser: the founder puts a market for the Shares to a vote and runs it; a buyer buys and sells on the launch page; a
# founder whose Shares are locked is told they cannot sell them; and the founder collects the trading fees into the
# treasury by another vote.
#
# ⚠️  DEV ONLY. A local chain; LBAMM is evaluation-only software and must be a clone kept OUTSIDE this repository.
#
# Usage:  LBAMM_DIR=/path/to/lbamm-examples scripts/web-market-journey-e2e.sh [playwright args]
# Env:    LBAMM_DIR (required), ANVIL_PORT, BUZZ_BIN (only the world's setup uses it), SKIP_BUILD=1

WORLD_NAME=web-market-journey
# shellcheck source=lib/market-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/market-world.sh"
world_up
lbamm_up
world_launch_with_lock

if lsof -ti tcp:4173 >/dev/null 2>&1; then
  fail "port 4173 is already serving something: a stale preview would run an old build (lsof -ti tcp:4173 | xargs kill)"
fi
cd "$REPO_ROOT/web"
EXCHANGE=$(node -e 'console.log(JSON.stringify({31337:{amm:process.argv[1],hook:process.argv[2],registry:process.argv[3],poolType:process.argv[4]}}))' \
  "$LBAMM" "$LBAMM_HOOK" "$LBAMM_REGISTRY" "$LBAMM_DYNAMIC")
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app, told where the exchange is"
  VITE_LAUNCHPAD_CHAIN_ID=31337 VITE_LOCAL_USDC="$CURRENCY" VITE_LBAMM_ADDRESSES="$EXCHANGE" \
    node_modules/.bin/vite build >/dev/null 2>&1 || fail "web build failed"
fi
step "running the browser spec"
E2E_ANVIL_URL="$RPC" E2E_DAO="$DAO" E2E_SHARES="$SHARES" E2E_CURRENCY="$CURRENCY" E2E_AMM="$LBAMM" \
  E2E_BUYER="$REVIEWER1" \
  node_modules/.bin/playwright test tests/e2e/launchpad-market-journey.spec.ts --project=smoke --reporter=list "$@"
