#!/usr/bin/env bash
#
# scripts/web-contributor-e2e.sh — a contributor project, entirely from the WEB app, on a REAL local chain.
#
# Boots a throwaway dev chain (the DAO maker, OrgBinding, is part of it) and runs web/tests/e2e/contributor-journey.spec.ts:
# the founder starts a contributor project from the Start page (the DAO is made with no sale, the project is published
# and its first work budget is opened), backs and runs that budget, approves a project inside it; a contributor files a
# claim that asks for no money; the manager takes it on, two reviewers approve it, it is finished and taken; the DAO
# votes the award; and the project's Contributions page, opened with no wallet, shows who earned how much for what.
#
# ⚠️  DEV ONLY. Anvil's public dev keys, a local chain, nothing else.
#
# Usage:  scripts/web-contributor-e2e.sh [playwright args]
# Env:    ANVIL_PORT, SKIP_BUILD=1 (reuse web/dist: only if it was built by this script for the same chain)

WORLD_NAME=web-contributor
WORLD_NO_CLI=1
# shellcheck source=lib/no-raise-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/no-raise-world.sh"

if lsof -ti tcp:4173 >/dev/null 2>&1; then
  fail "port 4173 is already serving something: a stale preview would run an old build (lsof -ti tcp:4173 | xargs kill)"
fi
world_up

role() { # <manifest> <role>
  node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((m.roles??[]).find((r)=>r.role===process.argv[2])?.address??"")' "$1" "$2"
}
BINDING="$(role "$DEPLOYMENTS/org-dao-31337.json" factory)"
KIT="$(role "$DEPLOYMENTS/dao-launch-kit-31337.json" launch-kit)"
[[ "$BINDING" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "the dev chain reported no DAO maker (org-dao-31337.json, role factory)"
[[ "$KIT" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "the dev chain reported no launch kit"
step "DAO maker ${BINDING}  kit ${KIT}  currency ${CURRENCY}"

cd "$REPO_ROOT/web"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app"
  VITE_LAUNCHPAD_CHAIN_ID=31337 VITE_LOCAL_USDC="$CURRENCY" \
    VITE_ORG_BINDINGS="{\"31337\":\"${BINDING}\"}" VITE_DAO_LAUNCH_KITS="{\"31337\":\"${KIT}\"}" \
    node_modules/.bin/vite build >/dev/null 2>&1 || fail "web build failed"
fi
step "running the browser spec"
E2E_ANVIL_URL="$RPC" E2E_BINDING="$BINDING" E2E_REVIEWER1="$REVIEWER1" E2E_REVIEWER2="$REVIEWER2" \
  E2E_CONTRIBUTOR="$CONTRIBUTOR" E2E_MANAGER="$MANAGER" \
  node_modules/.bin/playwright test tests/e2e/contributor-journey.spec.ts --project=smoke --reporter=list "$@"
