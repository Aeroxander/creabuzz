#!/usr/bin/env bash
#
# scripts/web-dao-journey-e2e.sh — a DAO run entirely from the WEB app, against a REAL local chain. No command line.
#
# A project is launched into its own DAO through the kit (that step has its own browser test). Then
# web/tests/e2e/launchpad-journey.spec.ts does everything else in a browser, each step as the person whose job it is:
# the founder puts a work budget to a vote, backs it, waits and runs it; puts a project to a vote the same way; a
# contributor files a claim, the project's manager takes it on, two reviewers approve it, it is finished and paid out;
# and the founder puts an award of Shares to a vote and runs it. The contributor ends up holding the Shares.
#
# ⚠️  DEV ONLY. Anvil's public dev keys, a local chain, nothing else.
#
# Usage:  scripts/web-dao-journey-e2e.sh [playwright args]
# Env:    ANVIL_PORT, BUZZ_BIN (default: build target/debug/buzz; only the world's setup uses it), SKIP_BUILD=1

WORLD_NAME=web-journey
# shellcheck source=lib/milestone-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/milestone-world.sh"
world_up
world_launch_with_lock

if lsof -ti tcp:4173 >/dev/null 2>&1; then
  fail "port 4173 is already serving something: a stale preview would run an old build (lsof -ti tcp:4173 | xargs kill)"
fi
cd "$REPO_ROOT/web"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app"
  VITE_LAUNCHPAD_CHAIN_ID=31337 VITE_LOCAL_USDC="$CURRENCY" node_modules/.bin/vite build >/dev/null 2>&1 || fail "web build failed"
fi
step "running the browser spec"
E2E_ANVIL_URL="$RPC" E2E_DAO="$DAO" E2E_SHARES="$SHARES" E2E_FACTORY="$FACTORY" E2E_CURRENCY="$CURRENCY" \
  E2E_REVIEWER1="$REVIEWER1" E2E_REVIEWER2="$REVIEWER2" E2E_CONTRIBUTOR="$CONTRIBUTOR" E2E_MANAGER="$MANAGER" \
  node_modules/.bin/playwright test tests/e2e/launchpad-journey.spec.ts --project=smoke --reporter=list "$@"
