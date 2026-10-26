#!/usr/bin/env bash
#
# scripts/web-post-bounty-e2e.sh — money behind a post (N2), entirely from the WEB app, on a REAL local chain.
#
# Boots a throwaway dev chain (which deploys OpenBounty with the dev USDC), builds the web app with that contract named
# (VITE_OPEN_BOUNTIES), and runs web/tests/e2e/post-bounty-journey.spec.ts: Ben puts money behind a post, Cara adds some,
# Dev submits work, both back it, a dip stops the wait, the wait runs out and anyone pays; a second bounty nobody earns
# is refunded. The server is stubbed in the page (it only serves the post).
#
# ⚠️  DEV ONLY. Anvil's public dev keys, a local chain, nothing public.
#
# Usage:  scripts/web-post-bounty-e2e.sh [playwright args]
# Env:    ANVIL_PORT, SKIP_BUILD=1 (reuse web/dist: only if this script built it for the same chain), E2E_SHOTS=<dir>

WORLD_NAME=web-post-bounty
WORLD_NO_CLI=1
# shellcheck source=lib/no-raise-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/no-raise-world.sh"

if lsof -ti tcp:4173 >/dev/null 2>&1; then
  fail "port 4173 is already serving something: a stale preview would run an old build (lsof -ti tcp:4173 | xargs kill)"
fi

world_up
OPEN_BOUNTY="$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((m.roles??[]).find((r)=>r.role==="open-bounty")?.address??"")' "$DEPLOYMENTS/open-bounty-31337.json")"
[[ "$OPEN_BOUNTY" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "no open bounty was deployed"
role() { node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((m.roles??[]).find((r)=>r.role===process.argv[2])?.address??"")' "$1" "$2"; }
COURT="$(role "$DEPLOYMENTS/court-31337.json" court)"
CREATE_TOKEN="$(role "$DEPLOYMENTS/create-31337.json" create-token)"
CREATE_FAUCET="$(role "$DEPLOYMENTS/create-31337.json" create-faucet)"
POOLS="$(role "$DEPLOYMENTS/forecast-pool-31337.json" forecast-pool)"
[[ "$COURT" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "no court was deployed"
# Dev appeals to the court, which costs a fee: 10 dev USDC is plenty.
cast send "$CURRENCY" "mint(address,uint256)" "$CONTRIBUTOR" 10000000 --private-key "$KEY_FOUNDER" --rpc-url "$RPC" >/dev/null \
  || fail "could not give Dev dev USDC"
step "open bounty ${OPEN_BOUNTY}  court ${COURT}  currency ${CURRENCY}"

cd "$REPO_ROOT/web"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app"
  VITE_LAUNCHPAD_CHAIN_ID=31337 VITE_LOCAL_USDC="$CURRENCY" VITE_OPEN_BOUNTIES="{\"31337\":\"${OPEN_BOUNTY}\"}" \
    VITE_COURTS="{\"31337\":\"${COURT}\"}" VITE_CREATE_TOKENS="{\"31337\":\"${CREATE_TOKEN}\"}" \
    VITE_CREATE_FAUCETS="{\"31337\":\"${CREATE_FAUCET}\"}" VITE_FORECAST_POOLS="{\"31337\":\"${POOLS}\"}" \
    node_modules/.bin/vite build >/dev/null 2>&1 || fail "web build failed"
fi
step "running the browser spec"
# Ben, Cara and Eve hold the dev USDC the chain mints (founder, buyer1, buyer2); Dev gets 10 above for a court fee.
E2E_ANVIL_URL="$RPC" E2E_OPEN_BOUNTY="$OPEN_BOUNTY" E2E_CURRENCY="$CURRENCY" E2E_COURT="$COURT" E2E_POOLS="$POOLS" \
  E2E_BEN="$FOUNDER" E2E_CARA="$REVIEWER1" E2E_EVE="$REVIEWER2" E2E_DEV="$CONTRIBUTOR" \
  node_modules/.bin/playwright test tests/e2e/post-bounty-journey.spec.ts --project=smoke --reporter=list "$@"
