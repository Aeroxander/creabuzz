#!/usr/bin/env bash
#
# scripts/web-milestone-e2e.sh — unlocking the team's Shares in the WEB app, against a REAL local chain.
#
# Builds the same world as `cli-milestone-e2e.sh` (a project launched into its own DAO through the kit, the team's Shares
# locked behind two milestones, a work budget, a project and a milestone claim that is Paid), stops before the unlock, and
# runs web/tests/e2e/launchpad-milestone.spec.ts: the founder sees what is locked on the Work tab, unlocks the first
# milestone with one click, and a stranger's wallet sees nothing of it.
#
# ⚠️  DEV ONLY. Anvil's public dev keys, a local chain, nothing else.
#
# Usage:  scripts/web-milestone-e2e.sh [playwright args]
# Env:    ANVIL_PORT, BUZZ_BIN (default: build target/debug/buzz), SKIP_BUILD=1 (reuse web/dist)

WORLD_NAME=web-milestone
# shellcheck source=lib/milestone-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/milestone-world.sh"
world_up
world_launch_with_lock
world_milestone_project
world_milestone_paid

if lsof -ti tcp:4173 >/dev/null 2>&1; then
  fail "port 4173 is already serving something: a stale preview would run an old build (lsof -ti tcp:4173 | xargs kill)"
fi
cd "$REPO_ROOT/web"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app"
  VITE_LAUNCHPAD_CHAIN_ID=31337 node_modules/.bin/vite build >/dev/null 2>&1 || fail "web build failed"
fi
step "running the browser spec"
E2E_ANVIL_URL="$RPC" E2E_DAO="$DAO" E2E_SHARES="$SHARES" E2E_LOCK="$LOCK" E2E_STRANGER="$REVIEWER2" \
  node_modules/.bin/playwright test tests/e2e/launchpad-milestone.spec.ts --project=smoke --reporter=list "$@"
