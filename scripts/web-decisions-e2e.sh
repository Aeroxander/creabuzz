#!/usr/bin/env bash
#
# scripts/web-decisions-e2e.sh — deciding in the WEB app, against a REAL local chain.
#
# A project is launched into its own DAO through the kit and a decision is opened (from the command line: the page reads
# it from the chain, so who opened it does not matter). Then web/tests/e2e/launchpad-decisions.spec.ts takes it from
# there in a browser: reads what it would do, backs it with the founder's Shares, lets the review and support periods
# pass, starts the wait, waits, and runs it, each as the founder's wallet.
#
# ⚠️  DEV ONLY. Anvil's public dev keys, a local chain, nothing else.
#
# Usage:  scripts/web-decisions-e2e.sh [playwright args]
# Env:    ANVIL_PORT, BUZZ_BIN (default: build target/debug/buzz), SKIP_BUILD=1 (reuse web/dist)

WORLD_NAME=web-decisions
# shellcheck source=lib/milestone-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/milestone-world.sh"
world_up
world_launch_with_lock

step "a decision is opened from the command line: a work budget of 100 Shares"
intent=$(as $KEY_FOUNDER work mandate --dao "$DAO" --factory "$FACTORY" --currency "$CURRENCY" \
  --share-budget 100 --share-cap 40 --expires-in-days 90 \
  --reviewer "$REVIEWER1" --reviewer "$REVIEWER2" --quorum 2)
as $KEY_FOUNDER propose --dao "$DAO" --to "$(echo "$intent" | jget to)" --data "$(echo "$intent" | jget data)" \
  --nonce "$(echo "$intent" | jget nonce)" >/dev/null || fail "could not open the decision"

if lsof -ti tcp:4173 >/dev/null 2>&1; then
  fail "port 4173 is already serving something: a stale preview would run an old build (lsof -ti tcp:4173 | xargs kill)"
fi
cd "$REPO_ROOT/web"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app"
  VITE_LAUNCHPAD_CHAIN_ID=31337 VITE_LOCAL_USDC="$CURRENCY" node_modules/.bin/vite build >/dev/null 2>&1 || fail "web build failed"
fi
step "running the browser spec"
E2E_ANVIL_URL="$RPC" E2E_DAO="$DAO" E2E_FACTORY="$FACTORY" E2E_CURRENCY="$CURRENCY" \
  node_modules/.bin/playwright test tests/e2e/launchpad-decisions.spec.ts --project=smoke --reporter=list "$@"
