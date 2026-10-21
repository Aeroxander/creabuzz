#!/usr/bin/env bash
#
# scripts/web-contributor-e2e.sh — a contributor project, entirely from the WEB app, on a REAL local chain.
#
# Boots a throwaway dev chain (the contributor kit is part of it) and runs web/tests/e2e/contributor-journey.spec.ts: the
# founder starts a contributor project from the Start page (one transaction makes the DAO with no sale, its first work
# budget and first project, and locks its Shares; then it is published); right away, with no vote, a contributor files a
# claim that asks for no money, the founder takes it on, two reviewers approve it, it is finished and taken; the DAO
# votes the award; and the project's Contributions page, opened with no wallet, shows who earned how much for what.
# A second journey has several people earn (D84): two first projects at Start, a newcomer with no Shares suggests work
# for 5% of the project, the founder puts it to a vote filled in from the suggestion, both people's claims are reviewed,
# paid and awarded by vote, and the Contributions page shows both.
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
CONTRIBUTOR_KIT="$(role "$DEPLOYMENTS/contributor-kit-31337.json" contributor-kit)"
KIT="$(role "$DEPLOYMENTS/dao-launch-kit-31337.json" launch-kit)"
[[ "$CONTRIBUTOR_KIT" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "the dev chain reported no contributor kit (contributor-kit-31337.json)"
[[ "$KIT" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "the dev chain reported no launch kit"
step "contributor kit ${CONTRIBUTOR_KIT}  launch kit ${KIT}  currency ${CURRENCY}"

cd "$REPO_ROOT/web"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app"
  VITE_LAUNCHPAD_CHAIN_ID=31337 VITE_LOCAL_USDC="$CURRENCY" \
    VITE_CONTRIBUTOR_KITS="{\"31337\":\"${CONTRIBUTOR_KIT}\"}" VITE_DAO_LAUNCH_KITS="{\"31337\":\"${KIT}\"}" \
    node_modules/.bin/vite build >/dev/null 2>&1 || fail "web build failed"
fi
step "running the browser spec"
E2E_ANVIL_URL="$RPC" E2E_KIT="$CONTRIBUTOR_KIT" E2E_REVIEWER1="$REVIEWER1" E2E_REVIEWER2="$REVIEWER2" \
  E2E_CONTRIBUTOR="$CONTRIBUTOR" E2E_MANAGER="$MANAGER" \
  node_modules/.bin/playwright test tests/e2e/contributor-journey.spec.ts --project=smoke --reporter=list "$@"
