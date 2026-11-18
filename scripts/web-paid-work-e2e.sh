#!/usr/bin/env bash
#
# scripts/web-paid-work-e2e.sh — paying a contributor MONEY, entirely from the WEB app, on a REAL local chain. No command line.
#
# A project is launched into its own DAO through the kit and its treasury is given 10,000 of the dev currency. Then
# web/tests/e2e/launchpad-paid-work.spec.ts does the rest in a browser: the founder votes a work budget that holds money and a
# project inside it; a contributor files a claim that asks to be paid and puts up a deposit; the manager takes it on, two
# reviewers approve it, it is finished, and the contributor is paid (and gets the deposit back).
#
# ⚠️  DEV ONLY. Anvil's public dev keys, a local chain, nothing else.
#
# Usage:  scripts/web-paid-work-e2e.sh [playwright args]
# Env:    ANVIL_PORT, BUZZ_BIN (only the world's setup uses it), SKIP_BUILD=1

WORLD_NAME=web-paid-work
# shellcheck source=lib/milestone-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/milestone-world.sh"
world_up
world_launch_with_lock

step "the treasury is given 10,000 of the dev currency to pay people with"
cast send --rpc-url "$RPC" --private-key "$KEY_FOUNDER" "$CURRENCY" "mint(address,uint256)" "$DAO" 10000000000 >/dev/null \
  || fail "could not fund the treasury"
step "the contributor is given 1,000 to put a deposit up with"
cast send --rpc-url "$RPC" --private-key "$KEY_FOUNDER" "$CURRENCY" "mint(address,uint256)" "$CONTRIBUTOR" 1000000000 >/dev/null \
  || fail "could not fund the contributor"

if lsof -ti tcp:4173 >/dev/null 2>&1; then
  fail "port 4173 is already serving something: a stale preview would run an old build (lsof -ti tcp:4173 | xargs kill)"
fi
cd "$REPO_ROOT/web"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app"
  VITE_LAUNCHPAD_CHAIN_ID=31337 VITE_LOCAL_USDC="$CURRENCY" node_modules/.bin/vite build >/dev/null 2>&1 || fail "web build failed"
fi
step "running the browser spec"
E2E_ANVIL_URL="$RPC" E2E_DAO="$DAO" E2E_SHARES="$SHARES" E2E_CURRENCY="$CURRENCY" \
  E2E_REVIEWER1="$REVIEWER1" E2E_REVIEWER2="$REVIEWER2" E2E_CONTRIBUTOR="$CONTRIBUTOR" E2E_MANAGER="$MANAGER" \
  node_modules/.bin/playwright test tests/e2e/launchpad-paid-work.spec.ts --project=smoke --reporter=list "$@"
