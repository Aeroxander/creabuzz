#!/usr/bin/env bash
#
# scripts/web-record-e2e.sh — a DAO's public track record in the WEB app, on a REAL local chain, for a DAO that moved MONEY.
#
# A project is launched into its own DAO through the kit and its treasury is given 10,000 of the dev currency. The DAO votes
# a work budget that holds 1,000 and a project inside it. One contributor claim is approved by two reviewers and paid; a
# second is turned down by both reviewers. Then web/tests/e2e/launchpad-record.spec.ts opens the track record with NO wallet
# and checks what a stranger would read: money set aside, paid and waiting, the team's milestones, and what happened.
#
# ⚠️  DEV ONLY. Anvil's public dev keys, a local chain, nothing else.
#
# Usage:  scripts/web-record-e2e.sh [playwright args]
# Env:    ANVIL_PORT, BUZZ_BIN (only the world's setup uses it), SKIP_BUILD=1 (reuse web/dist)

WORLD_NAME=web-record
# shellcheck source=lib/milestone-world.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/milestone-world.sh"
world_up
world_launch_with_lock

step "the treasury is given 10,000 of the dev currency"
cast send --rpc-url "$RPC" --private-key "$KEY_FOUNDER" "$CURRENCY" "mint(address,uint256)" "$DAO" 10000000000 >/dev/null \
  || fail "could not fund the treasury"

step "the DAO votes a work budget that holds 1,000, with two reviewers"
intent=$(as $KEY_FOUNDER work mandate --dao "$DAO" --factory "$FACTORY" --currency "$CURRENCY" --decimals 6 \
  --budget 1000 --cap 500 --expires-in-days 90 --reviewer "$REVIEWER1" --reviewer "$REVIEWER2" --quorum 2)
decide "$intent" 175000
MANDATE=$(cast logs --json --rpc-url "$RPC" --from-block 0 --address "$FACTORY" \
  "MandateCreated(address,address,address,uint128,uint128,uint128,uint128)" \
  | node -e 'const l=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log("0x"+l[l.length-1].topics[2].slice(-40))')
[[ "$MANDATE" =~ ^0x[0-9a-fA-F]{40}$ ]] || fail "no MandateCreated event from the factory"

step "the DAO votes a project with 500 to spend, run by a manager"
intent=$(as $KEY_FOUNDER work project --dao "$DAO" --mandate "$MANDATE" --id docs --manager "$MANAGER" \
  --amount 500 --decimals 6 --expires-in-days 30 --check-text "docs merged and reviewed")
decide "$intent" 90000

claim() { # <id> <amount>: the contributor files it, states the check, and the manager takes it on
  echo "evidence for $1" > "$STATE/$1.txt"
  as $KEY_CONTRIBUTOR work claim --mandate "$MANDATE" --id "$1" --amount "$2" --decimals 6 --evidence-file "$STATE/$1.txt" >/dev/null
  as $KEY_CONTRIBUTOR work check --mandate "$MANDATE" --id "$1" --check-text "docs merged and reviewed" >/dev/null
  as $KEY_MANAGER work bind --mandate "$MANDATE" --project docs --id "$1" --contributor "$CONTRIBUTOR" >/dev/null
}

step "a claim for 200 is approved by both reviewers and paid"
claim paid 200
as $KEY_REVIEWER1 work attest --mandate "$MANDATE" --id paid --verdict approve >/dev/null
as $KEY_REVIEWER2 work attest --mandate "$MANDATE" --id paid --verdict approve >/dev/null
as $KEY_REVIEWER1 work settle --mandate "$MANDATE" --id paid >/dev/null
warp 700000
as $KEY_CONTRIBUTOR work payout --mandate "$MANDATE" --id paid >/dev/null
[[ "$(as $KEY_CONTRIBUTOR work state --mandate "$MANDATE" --id paid | jget status)" == "Paid" ]] || fail "the first claim should be Paid"

step "a claim for 100 is turned down by both reviewers"
claim turned-down 100
as $KEY_REVIEWER1 work attest --mandate "$MANDATE" --id turned-down --verdict object >/dev/null
as $KEY_REVIEWER2 work attest --mandate "$MANDATE" --id turned-down --verdict object >/dev/null
as $KEY_REVIEWER1 work settle --mandate "$MANDATE" --id turned-down >/dev/null
[[ "$(as $KEY_CONTRIBUTOR work state --mandate "$MANDATE" --id turned-down | jget status)" == "Rejected" ]] || fail "the second claim should be Rejected"

if lsof -ti tcp:4173 >/dev/null 2>&1; then
  fail "port 4173 is already serving something: a stale preview would run an old build (lsof -ti tcp:4173 | xargs kill)"
fi
cd "$REPO_ROOT/web"
if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  step "building the web app"
  VITE_LAUNCHPAD_CHAIN_ID=31337 VITE_LOCAL_USDC="$CURRENCY" node_modules/.bin/vite build >/dev/null 2>&1 || fail "web build failed"
fi
step "running the browser spec"
E2E_ANVIL_URL="$RPC" E2E_DAO="$DAO" E2E_CURRENCY="$CURRENCY" E2E_CONTRIBUTOR="$CONTRIBUTOR" \
  E2E_REVIEWER1="$REVIEWER1" E2E_REVIEWER2="$REVIEWER2" \
  node_modules/.bin/playwright test tests/e2e/launchpad-record.spec.ts --project=smoke --reporter=list "$@"
