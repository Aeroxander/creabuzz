#!/usr/bin/env bash
#
# scripts/web-work-e2e.sh — the contributor path in the WEB app, against a REAL local chain.
#
# Uses the same world as `cli-no-raise-e2e.sh` (a throwaway dev chain, a DAO, a Shares-only work budget, a project and
# a claim, all made with `buzz launchpad work`), stops with the claim filed but not yet taken on, and runs
# web/tests/e2e/launchpad-work.spec.ts, where the project manager takes the claim on, two reviewers approve it,
# anyone finishes it, and the contributor takes it after the challenge window, each as that person's wallet.
#
# ⚠️  DEV ONLY. Anvil's public dev keys, a local chain, nothing else.
#
# Usage:  scripts/web-work-e2e.sh [playwright args]
# Env:    ANVIL_PORT, BUZZ_BIN (default: build target/debug/buzz), SKIP_BUILD=1 (reuse web/dist)

WORLD_NAME=web-work
# shellcheck source=lib/no-raise-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/no-raise-world.sh"
world_up
world_mandate
world_project
world_claim_filed

if lsof -ti tcp:4173 >/dev/null 2>&1; then
  fail "port 4173 is already serving something: a stale preview would run an old build (lsof -ti tcp:4173 | xargs kill)"
fi
cd "$REPO_ROOT/web"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app"
  VITE_LAUNCHPAD_CHAIN_ID=31337 node_modules/.bin/vite build >/dev/null 2>&1 || fail "web build failed"
fi
step "running the browser spec"
E2E_ANVIL_URL="$RPC" E2E_DAO="$DAO" E2E_MANDATE="$MANDATE" \
  E2E_MANAGER="$MANAGER" E2E_REVIEWER1="$REVIEWER1" E2E_REVIEWER2="$REVIEWER2" E2E_CONTRIBUTOR="$CONTRIBUTOR" \
  node_modules/.bin/playwright test tests/e2e/launchpad-work.spec.ts --project=smoke --reporter=list "$@"
